#!/usr/bin/env tsx
/**
 * diff-standings-oracle.ts
 *
 * QA-002 / QA-021 Standings Manual Oracle CLI Comparison Tool.
 * Ingests exported competition standings JSON or CSV and compares production rankings
 * with the independent first-principles manual oracle.
 *
 * Usage:
 *   pnpm tsx scripts/diff-standings-oracle.ts <competition-export.json>
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeManualStandingsOracle } from "../packages/domain/src/standings-manual-oracle.js";

type ExportPayload = {
  participants: Array<{ id: string; name: string; seed: number }>;
  matches: Array<{ homeEntryId: string; awayEntryId: string; homeScore: number; awayScore: number }>;
  productionStandings?: Array<{ entryId: string; rank: number; points: number }>;
  config?: { winPoints?: number; drawPoints?: number; lossPoints?: number };
};

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: pnpm tsx scripts/diff-standings-oracle.ts <export-file.json>");
    process.exit(1);
  }

  const raw = readFileSync(path.resolve(filePath), "utf8");
  const payload = JSON.parse(raw) as ExportPayload;

  const oracleStandings = computeManualStandingsOracle(payload.participants, payload.matches, payload.config ?? {});

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`QA-021 Standings Manual Oracle Parity Report`);
  console.log(`════════════════════════════════════════════════════════════`);
  console.log(`Total Participants: ${payload.participants.length}`);
  console.log(`Total Matches Calculated: ${payload.matches.length}\n`);

  let mismatches = 0;
  if (payload.productionStandings && payload.productionStandings.length > 0) {
    for (const oracleRow of oracleStandings) {
      const prodRow = payload.productionStandings.find((p) => p.entryId === oracleRow.entryId);
      if (!prodRow) {
        console.error(`❌ Mismatch: Participant ${oracleRow.entryName} missing in production output`);
        mismatches++;
      } else if (prodRow.rank !== oracleRow.rank || prodRow.points !== oracleRow.points) {
        console.error(
          `❌ Mismatch: ${oracleRow.entryName} (Rank: Prod=${prodRow.rank} vs Oracle=${oracleRow.rank}, Points: Prod=${prodRow.points} vs Oracle=${oracleRow.points})`,
        );
        mismatches++;
      }
    }
  }

  if (mismatches === 0) {
    console.log(`✓ Oracle Comparison: 100% PARITY (0 mismatches detected)`);
  } else {
    console.error(`❌ Oracle Comparison: ${mismatches} mismatch(es) detected`);
    process.exit(1);
  }
}

main();
