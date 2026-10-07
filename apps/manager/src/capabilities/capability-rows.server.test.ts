import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { beforeEach, describe, expect, it } from "vitest";
import { type GrantRow, replaceGrantStatements } from "../cloudflare/grant-store.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readRowsConnection } from "./capability-rows.server";

/** How "What this account can run" learns how Appflare connects: from the stored grant. */

function grant(scopes: readonly string[]): GrantRow {
  return {
    id: "grant-1",
    clientId: "client",
    scopes: [...scopes],
    refreshToken: "v1.sealed.refresh",
    accessToken: null,
    accessExpiresAt: null,
    keyId: "key",
    status: "connected",
    problem: null,
    problemAt: null,
    connectedAt: 1,
    refreshedAt: 1,
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("readRowsConnection", () => {
  it("is an API token while no grant is stored", async () => {
    expect(await readRowsConnection(env.DB)).toEqual({ kind: "api_token", missingScopes: [] });
  });

  it("is Cloudflare sign-in, with the manager permissions it was not given", async () => {
    await env.DB.batch(replaceGrantStatements(env.DB, grant(MANAGER_OAUTH_SCOPES)));
    expect(await readRowsConnection(env.DB)).toEqual({ kind: "oauth", missingScopes: [] });
    await env.DB.batch(
      replaceGrantStatements(
        env.DB,
        grant(MANAGER_OAUTH_SCOPES.filter((s) => s !== "d1.write" && s !== "zone.read")),
      ),
    );
    expect(await readRowsConnection(env.DB)).toEqual({
      kind: "oauth",
      missingScopes: ["d1.write", "zone.read"],
    });
  });
});
