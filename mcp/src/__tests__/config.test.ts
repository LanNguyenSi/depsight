import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.DEPSIGHT_URL;
    delete process.env.DEPSIGHT_API_TOKEN;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when DEPSIGHT_URL is unset", () => {
    process.env.DEPSIGHT_API_TOKEN = "dsat_x";
    expect(() => loadConfig()).toThrow(/DEPSIGHT_URL/);
  });

  it("throws when DEPSIGHT_API_TOKEN is unset", () => {
    process.env.DEPSIGHT_URL = "http://localhost:3000";
    expect(() => loadConfig()).toThrow(/DEPSIGHT_API_TOKEN/);
  });

  it("names the Settings page before the mint script in the missing-token error", () => {
    process.env.DEPSIGHT_URL = "http://localhost:3000";
    let message = "";
    try {
      loadConfig();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Settings page/);
    expect(message.indexOf("Settings page")).toBeLessThan(
      message.indexOf("scripts/mint-api-token.ts"),
    );
  });

  it("strips a single trailing slash from the URL", () => {
    process.env.DEPSIGHT_URL = "http://localhost:3000/";
    process.env.DEPSIGHT_API_TOKEN = "dsat_x";
    expect(loadConfig().gatewayUrl).toBe("http://localhost:3000");
  });

  it("keeps URLs without a trailing slash untouched", () => {
    process.env.DEPSIGHT_URL = "https://depsight.example.com";
    process.env.DEPSIGHT_API_TOKEN = "dsat_abc";
    const cfg = loadConfig();
    expect(cfg.gatewayUrl).toBe("https://depsight.example.com");
    expect(cfg.apiToken).toBe("dsat_abc");
  });
});
