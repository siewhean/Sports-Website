#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireSha(value) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`Migration certification requires an exact 40-character candidate SHA; got ${value}`);
  }
  return value.toLowerCase();
}

// Lex comments without confusing SQL strings with comments. The second view
// masks literals/quoted identifiers so their contents cannot supply keywords.
// Dollar-quoted bodies remain conservatively screened: this is not a SQL parser.
function sqlScreeningViews(sql) {
  let commentsRemoved = "";
  let keywordsOnly = "";
  const warnings = [];
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      commentsRemoved += " ";
      keywordsOnly += " ";
    } else if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) warnings.push("Unterminated SQL block comment");
      commentsRemoved += " ";
      keywordsOnly += " ";
    } else if (sql[i] === "$" && /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i))) {
      const delimiter = sql.slice(i).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)[0];
      const start = i,
        bodyStart = i + delimiter.length;
      const end = sql.indexOf(delimiter, bodyStart);
      if (end < 0) {
        warnings.push("Unterminated SQL dollar quote");
        commentsRemoved += sql.slice(i);
        i = sql.length;
      } else {
        // Preserve the entire literal for conservative destructive screening.
        // Inspect its body as well because DO/function bodies contain SQL.
        const executableBody = /\b(?:DO|AS)\s*$/i.test(keywordsOnly);
        const body = executableBody ? sqlScreeningViews(sql.slice(bodyStart, end)) : undefined;
        i = end + delimiter.length;
        commentsRemoved += sql.slice(start, i);
        keywordsOnly += body ? ` ${body.keywordsOnly} ` : " literal ";
        if (body) warnings.push(...body.warnings);
      }
    } else if (sql[i] === "'" || sql[i] === '"') {
      const start = i,
        quote = sql[i++];
      const escaped = quote === "'" && /(?:^|[^a-z0-9_$])e$/i.test(sql.slice(0, start));
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i++] !== quote) continue;
        if (sql[i] === quote) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) warnings.push("Unterminated SQL quoted token");
      commentsRemoved += sql.slice(start, i);
      keywordsOnly += quote === '"' ? " quoted_identifier " : " literal ";
    } else {
      commentsRemoved += sql[i];
      keywordsOnly += sql[i++];
    }
  }
  return { commentsRemoved, keywordsOnly, warnings };
}

export async function certifyGateFMigrations(candidateSha, options = {}) {
  const sha = requireSha(candidateSha);
  const artifactsDir = options.artifactsDir ?? path.join(root, "artifacts");
  const migrationsDir = options.migrationsDir ?? path.join(root, "packages/database/migrations");

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    throw new Error(`No database migrations found in ${migrationsDir}`);
  }

  // 1. Contiguous sequence verification (0001..NNNN)
  const sequenceErrors = [];
  const parsedSequences = [];
  for (const file of files) {
    const match = file.match(/^(\d{4})_(.+)\.sql$/);
    if (!match) {
      sequenceErrors.push(`Non-standard migration filename: ${file}`);
      continue;
    }
    const seq = parseInt(match[1], 10);
    parsedSequences.push({ file, seq, name: match[2] });
  }

  parsedSequences.sort((a, b) => a.seq - b.seq);

  let isSequenceContiguous = sequenceErrors.length === 0;
  if (isSequenceContiguous) {
    if (parsedSequences.length === 0 || parsedSequences[0].seq !== 1) {
      sequenceErrors.push(`Migration sequence must start at 0001; found start at ${parsedSequences[0]?.seq}`);
      isSequenceContiguous = false;
    }
    for (let i = 0; i < parsedSequences.length; i++) {
      const expected = i + 1;
      if (parsedSequences[i].seq !== expected) {
        sequenceErrors.push(
          `Migration sequence gap or duplicate at index ${i}: expected ${String(expected).padStart(4, "0")}, got ${String(parsedSequences[i].seq).padStart(4, "0")} (${parsedSequences[i].file})`,
        );
        isSequenceContiguous = false;
        break;
      }
    }
  }

  // 2. Destructive patterns and expand-contract discipline
  const destructivePatterns = [
    {
      label: "DROP TABLE",
      regex: /\bDROP\s+TABLE\b/i,
    },
    {
      label: "DROP COLUMN",
      regex: /\bDROP\s+COLUMN\b/i,
    },
    {
      label: "ALTER COLUMN TYPE",
      regex: /\bALTER\s+TABLE\s+[^;]*\bALTER\s+COLUMN\s+[^;]*\bTYPE\b/i,
    },
    {
      label: "TRUNCATE",
      regex: /\bTRUNCATE\b/i,
    },
    {
      label: "DROP SCHEMA",
      regex: /\bDROP\s+SCHEMA\b/i,
    },
  ];

  const migrationReports = [];
  let totalDestructiveViolations = 0;

  for (const file of files) {
    const content = await readFile(path.join(migrationsDir, file), "utf8");
    const views = sqlScreeningViews(content);
    const warnings = [...views.warnings];
    totalDestructiveViolations += warnings.length;
    const stripped = views.commentsRemoved;

    for (const pat of destructivePatterns) {
      if (pat.regex.test(stripped)) {
        warnings.push(`Matched potentially destructive pattern: ${pat.label}`);
        totalDestructiveViolations++;
      }
    }

    // Check for ADD COLUMN ... NOT NULL without DEFAULT
    const addColRegex =
      /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b)(?!PRIMARY\b)(?!UNIQUE\b)(?!FOREIGN\b)(?!CHECK\b)([a-z0-9_]+)\s+([^;]*?)(?=,\s*ADD\b|;|$)/gi;
    let match;
    while ((match = addColRegex.exec(views.keywordsOnly)) !== null) {
      const colName = match[1];
      const colDef = match[2];
      if (
        /\bNOT\s+NULL\b/i.test(colDef) &&
        (!/\bDEFAULT\b/i.test(colDef) || /\bDEFAULT\s*(?:\(\s*)?NULL\b/i.test(colDef))
      ) {
        warnings.push(
          `Matched non-contract column addition: ADD COLUMN "${colName}" NOT NULL without a non-NULL DEFAULT`,
        );
        totalDestructiveViolations++;
      }
    }

    migrationReports.push({
      file,
      hash: createHash("sha256").update(content).digest("hex"),
      safe_expand_contract: warnings.length === 0,
      warnings,
    });
  }

  const isExpandContractCompliant = migrationReports.every((m) => m.safe_expand_contract);
  const isDataPreservationCompliant = isExpandContractCompliant;
  // Static inspection cannot prove that applying or rerunning migrations is idempotent.
  // Reserve repeatability_verified for an actual isolated execution/replay audit.
  const isRepeatabilityVerified = false;
  const isSchemaVersionVerified = isSequenceContiguous && files.length > 0;
  const isBackwardCompatible = isExpandContractCompliant && isDataPreservationCompliant;

  const passesAll =
    isSequenceContiguous &&
    isExpandContractCompliant &&
    isDataPreservationCompliant &&
    isSchemaVersionVerified &&
    isBackwardCompatible;

  const receipt = {
    qa_item: "OPS-003",
    candidate_sha: sha,
    migration_count: files.length,
    sequence_start: parsedSequences[0]?.seq ?? 1,
    sequence_end: parsedSequences[parsedSequences.length - 1]?.seq ?? files.length,
    sequence_contiguous: isSequenceContiguous,
    sequence_errors: sequenceErrors,
    destructive_patterns_checked: [
      "DROP TABLE",
      "DROP COLUMN",
      "ALTER COLUMN TYPE",
      "TRUNCATE",
      "DROP SCHEMA",
      "NOT NULL additions without DEFAULT",
    ],
    destructive_violations_count: totalDestructiveViolations,
    migration_reports: migrationReports,
    expand_contract_compliant: isExpandContractCompliant,
    data_preservation_compliant: isDataPreservationCompliant,
    data_preservation_scope: "STATIC_DESTRUCTIVE_PATTERN_SCREENING_ONLY",
    repeatability_verified: isRepeatabilityVerified,
    repeatability_scope: "NOT_EXECUTED_BY_STATIC_CERTIFIER",
    backward_compatibility_scope: "STATIC_HEURISTIC_ONLY",
    schema_version_verified: isSchemaVersionVerified,
    backward_compatible: isBackwardCompatible,
    verdict: passesAll ? "PASS" : "FAIL",
    generated_at: new Date().toISOString(),
  };

  const receiptJson = JSON.stringify(receipt, null, 2);
  receipt.receipt_sha256 = createHash("sha256").update(receiptJson).digest("hex");

  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, "gate-f-migration-certification.json"), JSON.stringify(receipt, null, 2));

  // Migration files prove neither live database topology nor pool configuration.
  // ADR-0001 does not waive the archived OPS-010 public-read replica requirement.
  const topology = {
    qa_item: "OPS-010",
    candidate_sha: sha,
    evidence_scope: "SOURCE_REQUIREMENTS_ONLY",
    production_certification: false,
    topology: "NOT_VERIFIED",
    read_replica_disposition: "REQUIRED_BY_OPS_010_NOT_VERIFIED",
    requirements: {
      public_reads_routed_to_replica: true,
      acknowledged_write_host_az_rpo_seconds: 0,
      regional_rpo_max_seconds: 900,
      regional_rto_less_than_seconds: 3600,
      adr_0001_stakeholder_confirmation: "PENDING",
    },
    verdict: "PENDING",
    pending_reasons: [
      "independent_topology_and_public_read_routing_evidence_required",
      "host_and_availability_zone_write_durability_not_verified",
      "regional_wal_pitr_cross_region_recovery_not_verified",
      "pool_configuration_not_observed",
    ],
    generated_at: new Date().toISOString(),
  };
  topology.receipt_sha256 = createHash("sha256")
    .update(JSON.stringify(topology, null, 2))
    .digest("hex");
  await writeFile(path.join(artifactsDir, "gate-f-database-topology.json"), JSON.stringify(topology, null, 2));

  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.CANDIDATE_SHA;
  certifyGateFMigrations(sha)
    .then((r) => {
      console.log(`Gate F migration source screening: ${r.verdict} (${r.migration_count} migrations)`);
      if (r.verdict !== "PASS") process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
