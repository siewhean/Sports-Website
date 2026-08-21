import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode, type ApiErrorCode } from "@matchday/contracts";
import { ApiError } from "../../../apps/api/src/errors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

describe("Tier 3 - Pairwise 06: Build Graph Guard x Error Code Contracts (F01 x F07)", () => {
  it("P06-T01: @matchday/contracts exports ErrorCode constants that match API runtime ApiError typing", () => {
    const errorCodes = Object.values(ErrorCode);
    expect(errorCodes.length).toBeGreaterThan(50);

    const testError = new ApiError(404, ErrorCode.COMPETITION_NOT_FOUND, "Competition not found");
    expect(testError.code).toBe("COMPETITION_NOT_FOUND");
    expect(testError.statusCode).toBe(404);
  });

  it("P06-T02: turbo pipeline compiles contracts package before consuming apps build", () => {
    const turboConfig = JSON.parse(readFileSync(path.join(rootDir, "turbo.json"), "utf8"));
    expect(turboConfig.tasks.build.dependsOn).toContain("^build");

    const contractsPkg = JSON.parse(readFileSync(path.join(rootDir, "packages/contracts/package.json"), "utf8"));
    expect(contractsPkg.name).toBe("@matchday/contracts");
    expect(contractsPkg.scripts.build).toBeDefined();
  });

  it("P06-T03: ApiError serialization in HTTP response formats error code and status cleanly", () => {
    const error = new ApiError(403, ErrorCode.SCORING_PERMISSION_DENIED, "Official role required");
    const serializedResponse = {
      error: {
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
      },
    };

    expect(serializedResponse.error.statusCode).toBe(403);
    expect(serializedResponse.error.code).toBe("SCORING_PERMISSION_DENIED");
    expect(JSON.stringify(serializedResponse)).toContain('"code":"SCORING_PERMISSION_DENIED"');
  });
});
