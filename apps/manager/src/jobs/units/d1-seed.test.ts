import { NonRetryableError } from "cloudflare:workflows";
import {
  type CatalogD1Seed,
  catalogD1SeedSchema,
  PBKDF2_MAX_ITERATIONS,
  pbkdf2SeedHash,
} from "@appflare/schema";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { ACC, fakeAccount, TOKEN } from "../../test/fake-account";
import { toStepError } from "../errors";
import { StepLog } from "../step-log";
import type { D1SeedInput } from "./d1-seed";
import { failureError, settleUnit } from "./result";
import { createJobUnits } from "./units";

/**
 * The `seedD1` unit: hashes derived in the unit with the declared parameters,
 * one `/query` per statement with the values as bound params, and nothing it
 * handles in its log or its result.
 */

const USERNAME = "root-admin";
const PASSWORD = "correct horse battery staple";

const USERS_INSERT =
  "INSERT OR IGNORE INTO users (username, display_name, password_hash, password_salt, is_admin, is_disabled) VALUES (?, ?, ?, ?, 1, 0)";

const pbkdf2Seed: CatalogD1Seed = catalogD1SeedSchema.parse({
  hashes: {
    admin: {
      from: "ADMIN_PASSWORD",
      method: "pbkdf2-sha256",
      iterations: 100000,
      saltBytes: 16,
      keyBytes: 32,
      encoding: "base64url",
    },
  },
  statements: [
    {
      sql: USERS_INSERT,
      params: [
        { var: "ADMIN_USERNAME" },
        { var: "ADMIN_USERNAME" },
        { hash: "admin" },
        { salt: "admin" },
      ],
    },
    {
      sql: "INSERT OR IGNORE INTO settings (k, v) VALUES ('installed_by', ?)",
      params: [{ value: "appflare" }],
    },
  ],
});

const bcryptSeed: CatalogD1Seed = catalogD1SeedSchema.parse({
  hashes: { admin: { from: "ADMIN_PASSWORD", method: "bcrypt" } },
  statements: [
    {
      sql: `INSERT INTO "Admin" ("username", "password") VALUES ('admin', ?) ON CONFLICT("username") DO NOTHING`,
      params: [{ hash: "admin" }],
    },
  ],
  beforeSchema: true,
});

function seedWorld(seed: CatalogD1Seed) {
  const account = fakeAccount(null, { d1: [{ uuid: "d1-1", name: "chat-db" }] });
  const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch: account.fetch });
  const input: D1SeedInput = {
    accountId: ACC,
    databaseId: "d1-1",
    databaseName: "chat-db",
    binding: "DB",
    seed,
    values: { vars: { ADMIN_USERNAME: USERNAME }, secrets: { ADMIN_PASSWORD: PASSWORD } },
  };
  return { account, units, input };
}

/** Everything a unit call reports, as one string, to look for values in. */
function reported(result: unknown): string {
  return JSON.stringify(result);
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

describe("seedD1", () => {
  it("sends each statement as signed, with the values as bound params in order", async () => {
    const d = seedWorld(pbkdf2Seed);
    const result = await d.units.seedD1(d.input);
    expect(result).toMatchObject({
      ok: true,
      value: { statements: 2, changes: [1, 1], failed: null },
      subrequests: 2,
    });
    // The SQL is the statement as written: no value is ever part of it.
    expect(d.account.state.queries).toEqual([
      USERS_INSERT,
      "INSERT OR IGNORE INTO settings (k, v) VALUES ('installed_by', ?)",
    ]);
    for (const sql of d.account.state.queries) {
      expect(sql).not.toContain(USERNAME);
      expect(sql).not.toContain(PASSWORD);
    }
    const [params, literal] = d.account.state.queryParams as [string[], string[]];
    expect(params.slice(0, 2)).toEqual([USERNAME, USERNAME]);
    expect(literal).toEqual(["appflare"]);
    // The hash is PBKDF2-SHA-256 of the password with the salt it sent, 100,000 iterations.
    const [, , hash, salt] = params;
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const hashSpec = pbkdf2Seed.hashes?.admin;
    if (hashSpec?.method !== "pbkdf2-sha256") throw new Error("expected a PBKDF2 hash");
    const again = await pbkdf2SeedHash(hashSpec, PASSWORD, fromBase64Url(salt as string));
    expect(again).toEqual({ hash, salt });
    // Nothing it reports holds a value or a hash.
    const text = reported(result);
    for (const secret of [USERNAME, PASSWORD, hash as string, salt as string]) {
      expect(text).not.toContain(secret);
    }
    expect(result.log.lines.map((l) => l.message)).toEqual([
      "Ran seed statement 1 of 2 on chat-db: 1 row(s) added.",
      "Ran seed statement 2 of 2 on chat-db: 1 row(s) added.",
    ]);
  });

  it("derives a bcrypt hash that verifies against the password", async () => {
    const d = seedWorld(bcryptSeed);
    const result = await d.units.seedD1(d.input);
    expect(result.ok).toBe(true);
    const [hash] = (d.account.state.queryParams[0] ?? []) as string[];
    expect(hash).toMatch(/^\$2b\$10\$/);
    expect(bcrypt.compareSync(PASSWORD, hash as string)).toBe(true);
    expect(bcrypt.compareSync("admin123456", hash as string)).toBe(false);
    expect(reported(result)).not.toContain(hash as string);
  });

  it("refuses a bcrypt source longer than bcrypt reads, without naming the value", async () => {
    const d = seedWorld(bcryptSeed);
    const long = "p".repeat(73);
    const result = await d.units.seedD1({
      ...d.input,
      values: { ...d.input.values, secrets: { ADMIN_PASSWORD: long } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = toStepError(failureError(result.failure));
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error.message).toContain("73 bytes long; bcrypt reads at most 72");
    expect(error.message).not.toContain(long);
    expect(d.account.state.queries).toEqual([]);
  });

  it("fails without a query when a value is missing, naming the param but no value", async () => {
    const d = seedWorld(pbkdf2Seed);
    const result = await d.units.seedD1({
      ...d.input,
      values: { vars: {}, secrets: { ADMIN_PASSWORD: PASSWORD } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = toStepError(failureError(result.failure));
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error.message).toBe(
      "seed statement 1 of 2: the seed has no value for the var ADMIN_USERNAME",
    );
    expect(d.account.state.queries).toEqual([]);
  });

  it("refuses a statement the guard refuses, even when the caller did not check it", async () => {
    const d = seedWorld(pbkdf2Seed);
    const unsafe = structuredClone(pbkdf2Seed);
    (unsafe.statements[1] as { sql: string }).sql =
      "INSERT OR IGNORE INTO settings (k, v) VALUES ('x', ?); DROP TABLE users";
    const result = await d.units.seedD1({ ...d.input, seed: unsafe });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: "final" });
    expect(JSON.stringify(result.failure)).toContain("cannot run seedD1");
    expect(d.account.state.queries).toEqual([]);
  });

  it("stops at the statement D1 refuses and reports it by number with D1's message", async () => {
    const d = seedWorld(pbkdf2Seed);
    d.account.state.failOnce.set("POST /d1/database/d1-1/query", 400);
    const value = settleUnit(await d.units.seedD1(d.input), new StepLog());
    expect(value).toMatchObject({ statements: 0, changes: [] });
    if (value.failed === null) throw new Error("the call did not report its failure");
    const message = toStepError(failureError(value.failed)).message;
    expect(message).toMatch(/^seed statement 1 of 2: Cloudflare API request failed: POST /);
    expect(message).not.toContain(USERNAME);
  });
});

/**
 * Cloudflare's runtime refuses PBKDF2 above 100,000 iterations: workerd's
 * default `IsolateLimitEnforcer::checkPbkdfIterations` returns that cap, and
 * a deployed Worker answers 100,001 with "NotSupportedError: Pbkdf2 failed:
 * iteration counts above 100000 are not supported". The workerd these tests
 * run in overrides the check with no cap (`server.c++`), so here the cap is
 * the schema's own: the most a seed hash may ask for derives in workerd, and
 * one more is refused before any query runs.
 */
describe("PBKDF2 iterations", () => {
  it(`derives ${PBKDF2_MAX_ITERATIONS} iterations in workerd, and a seed may ask for no more`, async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(PASSWORD),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new Uint8Array(16),
        iterations: PBKDF2_MAX_ITERATIONS,
      },
      key,
      256,
    );
    expect(bits.byteLength).toBe(32);
    const over = structuredClone(pbkdf2Seed);
    const admin = over.hashes?.admin;
    if (admin?.method !== "pbkdf2-sha256") throw new Error("expected a PBKDF2 hash");
    admin.iterations = PBKDF2_MAX_ITERATIONS + 1;
    expect(catalogD1SeedSchema.safeParse(over).success).toBe(false);
    const d = seedWorld(pbkdf2Seed);
    const refused = await d.units.seedD1({ ...d.input, seed: over });
    expect(refused.ok).toBe(false);
    expect(d.account.state.queries).toEqual([]);
  });
});
