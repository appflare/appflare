import { env } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import type { AssetFile } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { Budget, BudgetExceededError, budgetedFetch } from "./budget";
import { readConfig } from "./config";
import { createMigrator, splitStatements } from "./db/migrate";
import { migrations } from "./db/migrations/index";
import { redactPath } from "./log";
import {
  normalizeHostname,
  parentNames,
  routeMatchesHostname,
  wildcardNames,
  workflowNameFor,
} from "./names";
import { expectedProof, MAX_ANSWER_BYTES, proofRetryAfterMs, readAtMost } from "./proof";
import { assetContentType, assetPartCost, jwtClaims, planAssetParts } from "./release/assets";
import { tagOfLatestRedirect } from "./release/source";
import { compareVersions } from "./versions";

describe("names", () => {
  it("normalizes hostnames and refuses anything that is not one", () => {
    expect(normalizeHostname(" App.Example.COM. ")).toBe("app.example.com");
    expect(normalizeHostname("bücher.example")).toBe("xn--bcher-kva.example");
    for (const bad of [
      "*.example.com",
      "https://a.example.com",
      "a.example.com/x",
      "localhost",
      "a b.com",
      "",
    ]) {
      expect(normalizeHostname(bad)).toBeNull();
    }
  });

  it("lists the names a hostname's zone can have, longest first, and the wildcards over it", () => {
    expect(parentNames("a.dev.example.com")).toEqual([
      "a.dev.example.com",
      "dev.example.com",
      "example.com",
    ]);
    expect(parentNames("example.com")).toEqual(["example.com"]);
    expect(normalizeHostname(`${"a.".repeat(10)}example.com`)).toBeNull();
    expect(wildcardNames("app.example.com", "example.com")).toEqual(["*.example.com"]);
    expect(wildcardNames("a.b.example.com", "example.com")).toEqual([
      "*.b.example.com",
      "*.example.com",
    ]);
    expect(wildcardNames("example.com", "example.com")).toEqual([]);
  });

  it("matches Workers route patterns against a hostname", () => {
    expect(routeMatchesHostname("app.example.com/*", "app.example.com")).toBe(true);
    expect(routeMatchesHostname("*.example.com/*", "app.example.com")).toBe(true);
    expect(routeMatchesHostname("*example.com/*", "example.com")).toBe(true);
    expect(routeMatchesHostname("app.example.com/api/*", "app.example.com")).toBe(true);
    expect(routeMatchesHostname("*.example.com/*", "example.com")).toBe(false);
    expect(routeMatchesHostname("other.example.com/*", "app.example.com")).toBe(false);
    expect(routeMatchesHostname("app.example.com.evil/*", "app.example.com")).toBe(false);
  });

  it("names the Workflow like create-appflare does", () => {
    expect(workflowNameFor("appflare-jobs", "appflare", "appflare")).toBe("appflare-jobs");
    expect(workflowNameFor("appflare-jobs", "appflare", "team")).toBe("team-jobs");
    expect(workflowNameFor("jobs", "appflare", "team")).toBe("team-jobs");
  });
});

describe("proof", () => {
  it("is the HMAC of the challenge keyed with the raw sha256 bytes, in base64url", async () => {
    const hash = "ab".repeat(32);
    const challenge = "c".repeat(32);
    const reference = createHmac("sha256", Buffer.from(hash, "hex"))
      .update(`appflare-handoff:${challenge}`)
      .digest("base64url");
    expect(await expectedProof(hash, challenge)).toBe(reference);
  });

  it("reads at most 16 KB of an answer and gives up on anything longer", async () => {
    expect(await readAtMost(new Response('{"app":"appflare"}'), MAX_ANSWER_BYTES)).toBe(
      '{"app":"appflare"}',
    );
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4096).fill(32));
      },
    });
    expect(await readAtMost(new Response(endless), MAX_ANSWER_BYTES)).toBeNull();
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it("waits longer the longer the address takes", () => {
    expect(proofRetryAfterMs(1)).toBe(3_000);
    expect(proofRetryAfterMs(10)).toBe(5_000);
    expect(proofRetryAfterMs(100)).toBe(15_000);
  });
});

describe("logs", () => {
  it("redacts every variable path segment", () => {
    expect(redactPath("/accounts/0123/workers/scripts/my-manager/secrets")).toBe(
      "/accounts/:id/workers/scripts/:id/secrets",
    );
    expect(redactPath("/zones/z1/dns_records?name.exact=app.example.com")).toBe(
      "/zones/:id/dns_records",
    );
    expect(redactPath("/accounts/a/workers/assets/upload/0123abcd")).toBe(
      "/accounts/:id/workers/assets/upload/:id",
    );
  });
});

describe("budget", () => {
  it("refuses the 41st subrequest of a request", async () => {
    const budget = new Budget();
    const fetch = budgetedFetch(async () => new Response("ok"), budget);
    for (let i = 0; i < 40; i++) await fetch("https://x.test/");
    await expect(fetch("https://x.test/")).rejects.toThrow(BudgetExceededError);
  });
});

describe("configuration", () => {
  const base = {
    DB: env.DB,
    INSTALLER_ENV: "production",
    INSTALLER_ORIGIN: "https://appflare.dev",
    MIN_MANAGER_VERSION: "0.4.0",
  };

  it("reads a production configuration", () => {
    expect(readConfig(base)).toEqual({
      environment: "production",
      origin: "https://appflare.dev",
      minManagerVersion: "0.4.0",
      devRelease: null,
    });
  });

  it("refuses development overrides, a plain-http origin and a missing version in production", () => {
    expect(() => readConfig({ ...base, DEV_RELEASE_KEYS: "[]" })).toThrow(/DEV_RELEASE_KEYS/);
    expect(() => readConfig({ ...base, INSTALLER_ORIGIN: "http://localhost:8787" })).toThrow(
      /INSTALLER_ORIGIN/,
    );
    expect(() => readConfig({ ...base, INSTALLER_ORIGIN: "https://appflare.dev/deploy" })).toThrow(
      /INSTALLER_ORIGIN/,
    );
    expect(() => readConfig({ ...base, MIN_MANAGER_VERSION: "latest" })).toThrow(
      /MIN_MANAGER_VERSION/,
    );
  });

  it("allows a local origin in development and names the variables without their values", () => {
    expect(
      readConfig({
        ...base,
        INSTALLER_ENV: "development",
        INSTALLER_ORIGIN: "http://localhost:8787",
      }).origin,
    ).toBe("http://localhost:8787");
    try {
      readConfig({
        ...base,
        INSTALLER_ENV: "development",
        DEV_RELEASE_URL: "https://secret.test/x",
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/DEV_RELEASE_URL and DEV_RELEASE_KEYS go together/);
      expect(String(error)).not.toContain("secret.test");
    }
  });
});

describe("releases", () => {
  it("reads the tag of github.com's latest-release redirect", () => {
    expect(
      tagOfLatestRedirect("https://github.com/appflare/appflare/releases/tag/manager%400.4.0"),
    ).toBe("manager@0.4.0");
    expect(
      tagOfLatestRedirect("https://github.com/other/repo/releases/tag/manager@0.4.0"),
    ).toBeNull();
    expect(tagOfLatestRedirect(null)).toBeNull();
  });

  it("orders versions by semver precedence", () => {
    expect(compareVersions("0.4.0", "0.3.1")).toBe(1);
    expect(compareVersions("0.4.0-rc.1", "0.4.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("latest", "0.4.0")).toBeNull();
  });
});

describe("asset parts", () => {
  const file = (i: number, size = 10): AssetFile => ({
    route: `/f${i}.js`,
    path: `assets/f${i}.js`,
    hash: i.toString(16).padStart(32, "0"),
    sha256: "0".repeat(64),
    size,
    offset: i * 100,
  });

  it("keeps every part within its subrequest budget, one file per upload when asked", () => {
    const files = Array.from({ length: 200 }, (_, i) => file(i));
    for (const single of [true, false]) {
      const parts = planAssetParts(files, single);
      expect(parts.flatMap((p) => p.files)).toHaveLength(200);
      for (const part of parts) {
        expect(part.subrequests).toBeLessThanOrEqual(34);
        expect(part.subrequests).toBe(assetPartCost(part.ranges, part.files.length, single));
      }
    }
  });

  it("serves text with a charset and unknown files without a type", () => {
    expect(assetContentType("/index.html")).toBe("text/html; charset=utf-8");
    expect(assetContentType("/logo.png")).toBe("image/png");
    expect(assetContentType("/data.bin")).toBe("application/null");
  });

  it("reads the upload session's single-upload claim", () => {
    const claims = btoa(JSON.stringify({ wrangler_single_asset_uploads: true })).replace(/=+$/, "");
    expect(jwtClaims(`h.${claims}.s`)).toEqual({ wrangler_single_asset_uploads: true });
    expect(jwtClaims("not-a-jwt")).toEqual({});
  });
});

describe("migrations", () => {
  it("apply once, record their version, and race safely", async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS mig_probe").run();
    await env.DB.prepare("DROP TABLE IF EXISTS _migrations").run();
    const list = [
      {
        tag: "0000_a",
        sql: "CREATE TABLE mig_probe (id TEXT);--> statement-breakpoint\nCREATE INDEX mig_probe_id ON mig_probe (id);",
      },
    ];
    const [first, second] = [createMigrator(list), createMigrator(list)];
    const results = await Promise.all([first.ensure(env.DB), second.ensure(env.DB)]);
    expect(results).toEqual([1, 1]);
    const rows = await env.DB.prepare("SELECT version, tag FROM _migrations").all();
    expect(rows.results).toEqual([{ version: 1, tag: "0000_a" }]);
    // Record the installer's own migration again (its table is still there) for the other tests.
    await env.DB.prepare("DROP TABLE mig_probe").run();
    await env.DB.prepare("UPDATE _migrations SET tag = '0000_init' WHERE version = 1").run();
    expect(await createMigrator(migrations).ensure(env.DB)).toBe(1);
  });

  it("ship the SQL drizzle-kit generated", async () => {
    expect(migrations.map((m) => m.tag)).toEqual(["0000_init"]);
    expect(splitStatements(migrations[0]?.sql ?? "")[0]).toMatch(/^CREATE TABLE `installations`/);
  });
});
