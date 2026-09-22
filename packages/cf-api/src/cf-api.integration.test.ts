import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { type DevContext, hasDevContext, loadDevContext } from "./dev";

/**
 * Read-only smoke test against the dev account. Skipped unless the repo-root
 * `.env` provides credentials. It creates nothing: it only verifies the token and
 * lists scripts, asserting the response shapes.
 *
 * The dev context is read once at import time (before any test runs), so it never
 * depends on `process.cwd()` while other files' tests run — `dev.test.ts` calls
 * `process.chdir`, and vitest may share a process across files.
 */
const dev: DevContext | null = hasDevContext() ? loadDevContext() : null;

describe.skipIf(dev === null)("cf-api integration (dev account, read-only)", () => {
  const context = dev as DevContext;

  it("verifies the token", async () => {
    const client = createClient(context);

    // Prefer the account-token endpoint; fall back to the user-token one so the
    // test passes whichever kind of token the dev account is configured with.
    const verify = await client.tokens.verify().catch(() => client.tokens.verifyUserToken());

    expect(typeof verify.id).toBe("string");
    expect(verify.status).toBe("active");
  });

  it("lists scripts as an array", async () => {
    const client = createClient(context);

    const scripts = await client.workers.listScripts();
    expect(Array.isArray(scripts)).toBe(true);
    for (const script of scripts) {
      expect(typeof script.id).toBe("string");
    }
  });
});
