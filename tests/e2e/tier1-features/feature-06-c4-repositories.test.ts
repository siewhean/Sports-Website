import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 1 - Feature 06: C4 V2 Repository Layer Alignment", () => {
  it("F06-T01: RepairRepository defines required CRUD and revision lifecycle methods", () => {
    const repoPath = path.join(rootDir, "apps/api/src/repositories/repair.repository.ts");
    expect(existsSync(repoPath)).toBe(true);
    const content = readFileSync(repoPath, "utf8");
    expect(content).toContain("class RepairRepository");
    expect(content).toContain("createCase");
    expect(content).toContain("appendRevision");
    expect(content).toContain("findRevisionById");
    expect(content).toContain("findLatestRevision");
    expect(content).toContain("findActionsByRevisionId");
    expect(content).toContain("findAdjustmentsByRevisionId");
  });

  it("F06-T02: PublicationRepository defines findByCompetitionId and upsert methods", () => {
    const repoPath = path.join(rootDir, "apps/api/src/repositories/publication.repository.ts");
    expect(existsSync(repoPath)).toBe(true);
    const content = readFileSync(repoPath, "utf8");
    expect(content).toContain("class PublicationRepository");
    expect(content).toContain("findByCompetitionId");
    expect(content).toContain("getVersions");
    expect(content).toContain("upsert");
  });

  it("F06-T03: PublicProjectionRepository defines public projection persistence and retrieval", () => {
    const repoPath = path.join(rootDir, "apps/api/src/repositories/public-projection.repository.ts");
    expect(existsSync(repoPath)).toBe(true);
    const content = readFileSync(repoPath, "utf8");
    expect(content).toContain("class PublicProjectionRepository");
    expect(content).toContain("upsertDivisionProjection");
    expect(content).toContain("findDivisionProjection");
    expect(content).toContain("findAllByCompetitionId");
  });

  it("F06-T04: repositories index exports all C4 repositories alongside V2 domain repositories", () => {
    const indexPath = path.join(rootDir, "apps/api/src/repositories/index.ts");
    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, "utf8");
    expect(content).toContain("repair.repository.js");
    expect(content).toContain("publication.repository.js");
    expect(content).toContain("public-projection.repository.js");
    expect(content).toContain("competition.repository.js");
    expect(content).toContain("scoring.repository.js");
  });

  it("F06-T05: repository classes support optional transaction context Sql | SqlTransaction", () => {
    const typesPath = path.join(rootDir, "apps/api/src/repositories/types.ts");
    expect(existsSync(typesPath)).toBe(true);
    const content = readFileSync(typesPath, "utf8");
    expect(content).toContain("SqlExecutor");
  });
});
