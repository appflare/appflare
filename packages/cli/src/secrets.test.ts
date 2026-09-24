import { describe, expect, it } from "vitest";
import { formatManagerUrl, generateBetterAuthSecret } from "./secrets.ts";

describe("the auth secret and the manager URL", () => {
  it("generates a 32-byte base64url auth secret", () => {
    expect(generateBetterAuthSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateBetterAuthSecret()).not.toBe(generateBetterAuthSecret());
  });

  it("prints the plain manager URL, with nothing secret in it", () => {
    expect(formatManagerUrl("https://appflare.acme.workers.dev")).toBe(
      "https://appflare.acme.workers.dev/",
    );
    expect(formatManagerUrl("https://appflare.acme.workers.dev/setup?token=x#y")).toBe(
      "https://appflare.acme.workers.dev/",
    );
  });

  it("refuses a non-https URL", () => {
    expect(() => formatManagerUrl("http://appflare.acme.workers.dev")).toThrow("https://");
  });
});
