import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVercelDeployment } from "./verify-vercel-deployment.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

describe("verifyVercelDeployment", () => {
  const dummySha = "1111111111111111111111111111111111111111";
  const artifactDir = path.join(rootDir, "artifacts", "qa", "deployment");
  const artifactPath = path.join(artifactDir, "vercel-response.json");

  it("fails when no deployment artifact exists and no token is supplied", async () => {
    await expect(
      verifyVercelDeployment({
        candidateSha: "9999999999999999999999999999999999999999",
      }),
    ).rejects.toThrow();
  });

  it("verifies authentic artifact payload when state is READY and SHA matches", async () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    const payload = {
      schema_version: "gate-c-vercel-deployment-v1",
      candidate_sha: dummySha,
      provider: "vercel",
      project_id: "prj_matchday_sports_platform",
      deployment_id: "dpl_gate_c_final_1111111111",
      git_branch: "integration/gate-c-final",
      git_commit_sha: dummySha,
      environment: "preview",
      state: "READY",
      created_at: "2026-08-21T09:10:00.000Z",
      verified_at: "2026-08-21T09:15:00.000Z",
    };
    fs.writeFileSync(artifactPath, JSON.stringify(payload, null, 2), "utf8");

    const result = await verifyVercelDeployment({ candidateSha: dummySha });
    expect(result.verified).toBe(true);
    expect(result.deployment.state).toBe("READY");
    expect(result.deployment.deployment_id).toBe("dpl_gate_c_final_1111111111");

    fs.unlinkSync(artifactPath);
  });

  it("rejects artifact payload if state is not READY", async () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    const payload = {
      candidate_sha: dummySha,
      deployment_id: "dpl_test_failed",
      state: "BUILDING",
    };
    fs.writeFileSync(artifactPath, JSON.stringify(payload, null, 2), "utf8");

    await expect(verifyVercelDeployment({ candidateSha: dummySha })).rejects.toThrow(/READY/);

    fs.unlinkSync(artifactPath);
  });
});
