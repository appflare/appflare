import { describe, expect, it } from "vitest";
import { formatSetupUrl, generateBetterAuthSecret, generateSetupToken } from "./secrets.ts";

describe("secrets and the setup URL", () => {
  it("generates a 32-byte base64url auth secret and a 48-hex setup token", () => {
    expect(generateBetterAuthSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSetupToken()).toMatch(/^[0-9a-f]{48}$/);
    expect(generateSetupToken()).not.toBe(generateSetupToken());
  });
  it("formats the setup link", () => {
    expect(formatSetupUrl("https://appflare.acme.workers.dev", "ab12")).toBe(
      "https://appflare.acme.workers.dev/setup?token=ab12",
    );
    expect(formatSetupUrl("https://appflare.acme.workers.dev/", "ab12")).toBe(
      "https://appflare.acme.workers.dev/setup?token=ab12",
    );
  });
  it("refuses a non-https URL", () => {
    expect(() => formatSetupUrl("http://appflare.acme.workers.dev", "t")).toThrow("https://");
  });
});
