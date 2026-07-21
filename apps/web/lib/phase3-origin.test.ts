import { describe, expect, it } from "vitest";
import { requestOriginMatchesHost } from "./phase3-origin";

describe("Phase 3 same-origin boundary", () => {
  it("accepts the actual request host even when framework URL canonicalisation differs", () => {
    expect(requestOriginMatchesHost("http://127.0.0.1:3111", "127.0.0.1:3111", "http")).toBe(true);
    expect(requestOriginMatchesHost("https://matchday.example", "matchday.example", "https")).toBe(true);
  });

  it("rejects cross-host, protocol, credential and malformed origins", () => {
    expect(requestOriginMatchesHost("http://localhost:3111", "127.0.0.1:3111", "http")).toBe(false);
    expect(requestOriginMatchesHost("http://matchday.example", "matchday.example", "https")).toBe(false);
    expect(requestOriginMatchesHost("https://user@matchday.example", "matchday.example", "https")).toBe(false);
    expect(requestOriginMatchesHost("not-an-origin", "matchday.example", "https")).toBe(false);
  });
});
