import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const FULL = {
  GCP_PROJECT_ID: "p", GCP_PROJECT_NUMBER: "123", GEMINI_API_KEY: "k",
  OAUTH_CLIENT_ID: "id", OAUTH_CLIENT_SECRET: "s", API_SECRET: "sec",
  USER_EMAIL: "u@x.com",
};

describe("loadConfig", () => {
  it("loads all vars with defaults", () => {
    const c = loadConfig(FULL);
    expect(c.geminiModel).toBe("gemini-2.5-flash");
    expect(c.logOnly).toBe(false);
    expect(c.userEmail).toBe("u@x.com");
  });
  it("throws naming the missing var", () => {
    const { GEMINI_API_KEY, ...rest } = FULL;
    expect(() => loadConfig(rest)).toThrow(/GEMINI_API_KEY/);
  });
  it("parses LOG_ONLY=true", () => {
    expect(loadConfig({ ...FULL, LOG_ONLY: "true" }).logOnly).toBe(true);
  });
});
