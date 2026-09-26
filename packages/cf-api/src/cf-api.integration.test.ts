import { describe, expect, it } from "vitest";
import {
  probeAccountCapabilities,
  probeAnalyticsEngine,
  probeDomainCapabilities,
} from "./capabilities";
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

  it("reads the account's capabilities with one read call each", async () => {
    const calls: string[] = [];
    const client = createClient({
      ...context,
      onRequest: ({ method, path, status }) => calls.push(`${method} ${path} -> ${status}`),
    });

    const capabilities = await probeAccountCapabilities(client);
    // The dev token may lack a permission; then the probe says so instead of guessing.
    expect(["enabled", "not-enabled", "unknown"]).toContain(capabilities.r2.state);
    expect(["available", "needs-workers-paid", "unknown"]).toContain(capabilities.containers.state);
    expect(["free", "paid", "unknown"]).toContain(capabilities.workersPlan.state);
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(capabilities)).not.toContain(context.token);
  });

  it("reads the account's domain capabilities with at most two read calls", async () => {
    const calls: string[] = [];
    const client = createClient({
      ...context,
      onRequest: ({ method, path, status }) => calls.push(`${method} ${path} -> ${status}`),
    });

    const domains = await probeDomainCapabilities(client);
    expect(["available", "none", "unknown"]).toContain(domains.zone.state);
    expect(["available", "no-zone", "unknown"]).toContain(domains.emailRouting.state);
    if (domains.zone.state === "none") expect(domains.emailRouting.state).toBe("no-zone");
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(domains)).not.toContain(context.token);
    expect(JSON.stringify(domains)).not.toContain(context.accountId);
  });

  it("reads whether Analytics Engine is on with one SQL read", async () => {
    const calls: string[] = [];
    const client = createClient({
      ...context,
      onRequest: ({ method, path }) => calls.push(`${method} ${path}`),
    });

    const analyticsEngine = await probeAnalyticsEngine(client);
    expect(["enabled", "not-enabled", "unknown"]).toContain(analyticsEngine.state);
    // A SHOW statement: the SQL API takes it as a POST body but changes nothing.
    expect(calls).toEqual([`POST /accounts/${context.accountId}/analytics_engine/sql`]);
    expect(JSON.stringify(analyticsEngine)).not.toContain(context.token);
  });
});

describe.skipIf(dev === null)("cf-api integration: Email Routing (dev account, read-only)", () => {
  const context = dev as DevContext;

  it("lists destination addresses", async () => {
    const addresses = await createClient(context).emailRouting.listDestinationAddresses();
    expect(Array.isArray(addresses)).toBe(true);
  });

  it("reads a zone's settings, rules, catch-all, and needed records when the account has a zone", async () => {
    const client = createClient(context);
    const [zone] = await client.zones.listZones({ accountId: context.accountId });
    if (zone === undefined) return;
    const settings = await client.emailRouting.getSettings(zone.id);
    expect(settings.name).toBe(zone.name);
    expect(typeof settings.enabled).toBe("boolean");
    expect(Array.isArray(await client.emailRouting.listRules(zone.id))).toBe(true);
    const catchAll = await client.emailRouting.getCatchAll(zone.id);
    expect(catchAll.matchers).toEqual([{ type: "all" }]);
    // The records routing needs are listed whether or not it is on.
    const records = await client.emailRouting.getDnsRecords(zone.id);
    expect(records.some((r) => r.type === "MX")).toBe(true);
  });
});
