import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetZoneNames } from "../../access/probe-credentials.server";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { accessChallenge } from "../../test/access-sign-in";
import { ACC, TOKEN } from "../../test/fake-account";
import { recordProtectedInstall } from "../../test/protected-install";
import { INSTALL_ID, seedInstall } from "../../test/seed-install";
import { createJobUnits } from "./units";

/**
 * The custom domain check of an app protected with Cloudflare Access: with
 * the install's own service token it reaches the app through the new
 * domain, once the domain's zone is confirmed to be the account's.
 */

const AUTH = "auth-secret-0123456789abcdef0123456789";
const SECRET = "client-secret-DO-NOT-LEAK";

function world(zones: string[]) {
  const sent: Array<Record<string, string>> = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "api.cloudflare.com") {
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: zones.map((name, i) => ({
          id: `z${i}`,
          name,
          status: "active",
          account: { id: ACC },
        })),
        result_info: { page: 1, total_pages: 1 },
      });
    }
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    sent.push(headers);
    return headers["CF-Access-Client-Secret"] === SECRET
      ? new Response("app", { status: 200 })
      : accessChallenge(url.hostname);
  };
  const units = createJobUnits(
    { CF_API_TOKEN: TOKEN, DB: env.DB, BETTER_AUTH_SECRET: AUTH },
    { fetch, sleep: async () => {} },
  );
  return { units, sent };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  forgetZoneNames();
  await seedInstall({ resources: [{ kind: "domain", name: "app.example.com" }] });
  await recordProtectedInstall({
    installId: INSTALL_ID,
    authSecret: AUTH,
    secret: SECRET,
    clientId: "client-1.access",
  });
});

describe("waitForCustomDomain with a service token", () => {
  const input = {
    accountId: ACC,
    installId: INSTALL_ID,
    healthUrl: "https://app.example.com/",
    healthMode: "no-server-errors" as const,
    maxProbes: 1,
  };

  it("reaches the protected app through a domain in the account's zone", async () => {
    const { units, sent } = world(["example.com"]);
    const result = await units.waitForCustomDomain(input);
    expect(result).toMatchObject({
      ok: true,
      value: { serves: true, health: { status: "verified", detail: "HTTP 200" } },
    });
    // Without the token first; with it only after Access's sign-in for this host.
    expect(sent[0]?.["CF-Access-Client-Id"]).toBeUndefined();
    expect(sent[1]?.["CF-Access-Client-Id"]).toBe("client-1.access");
    expect(JSON.stringify(result)).not.toContain("DO-NOT-LEAK");
  });

  it("sends nothing when the zone is not the account's, or no install is named", async () => {
    const { units, sent } = world(["other.org"]);
    const result = await units.waitForCustomDomain(input);
    expect(result).toMatchObject({ ok: true, value: { health: { access: true } } });
    expect(sent.every((h) => h["CF-Access-Client-Secret"] === undefined)).toBe(true);
    const unnamed = world(["example.com"]);
    const { installId: _omitted, ...withoutInstall } = input;
    await unnamed.units.waitForCustomDomain(withoutInstall);
    expect(unnamed.sent.every((h) => h["CF-Access-Client-Secret"] === undefined)).toBe(true);
  });
});
