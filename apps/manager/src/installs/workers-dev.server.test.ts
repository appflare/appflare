import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CloudflareClient, EnableSubdomainArgs } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { MAX_DOMAIN_PROBES, setWorkersDevCore } from "./workers-dev.server";

/**
 * "Serve on workers.dev" against the local D1, a fake subdomain call, and
 * fake answers from the install's custom domains.
 */

type Answer = { status: number; body: string } | "unreachable";

function world(answers: Record<string, Answer> = {}) {
  const subdomainCalls: Array<{ name: string; args: EnableSubdomainArgs }> = [];
  const probes: string[] = [];
  const deps = {
    db: env.DB,
    api: async () => ({
      workers: {
        async enableSubdomain(name: string, args: EnableSubdomainArgs) {
          subdomainCalls.push({ name, args });
          return { enabled: args.enabled, previews_enabled: args.previews_enabled ?? false };
        },
        // Only enableSubdomain is ever called here.
      } as unknown as CloudflareClient["workers"],
    }),
    fetch: async (input: string) => {
      const host = new URL(input).host;
      probes.push(host);
      const answer = answers[host];
      if (answer === undefined || answer === "unreachable") throw new Error("connect failed");
      return new Response(answer.body, { status: answer.status });
    },
  };
  return { deps, subdomainCalls, probes };
}

async function addDomain(id: string, hostname: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO resources (id, install_id, kind, name, cf_id, created_at)
     VALUES (?1, ?2, 'domain', ?3, 'dom', 1)`,
  )
    .bind(`${INSTALL_ID}:domain:${id}`, INSTALL_ID, hostname)
    .run();
}

async function stored(): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT workers_dev_enabled FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ workers_dev_enabled: number }>();
  return row?.workers_dev_enabled;
}

async function servedDomain(): Promise<string | null | undefined> {
  const row = await env.DB.prepare("SELECT served_domain FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ served_domain: string | null }>();
  return row?.served_domain;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
});

describe("setWorkersDevCore", () => {
  it("is on for a new install", async () => {
    expect(await stored()).toBe(1);
  });

  it("refuses to turn it off without a custom domain, before calling Cloudflare", async () => {
    const w = world();
    await expect(
      setWorkersDevCore(w.deps, { installId: INSTALL_ID, enabled: false }),
    ).rejects.toThrow(
      "This app has no custom or external domain, so workers.dev is its only address.",
    );
    expect(w.subdomainCalls).toEqual([]);
    expect(await stored()).toBe(1);
  });

  it("refuses to turn it off while no custom domain answers as the app", async () => {
    await addDomain("01A", "links.example.com");
    await addDomain("01B", "pending.example.com");
    const w = world({
      // Cloudflare's own error page is not the app answering.
      "links.example.com": { status: 403, body: "error code: 1014" },
      "pending.example.com": "unreachable",
    });
    await expect(
      setWorkersDevCore(w.deps, { installId: INSTALL_ID, enabled: false }),
    ).rejects.toThrow(
      "None of this app's domains answered as the app (links.example.com, pending.example.com)",
    );
    expect(w.subdomainCalls).toEqual([]);
    expect(await stored()).toBe(1);
  });

  it("turns it off once a custom domain serves the app, keeping previews on", async () => {
    await addDomain("01A", "broken.example.com");
    await addDomain("01B", "links.example.com");
    const w = world({
      "broken.example.com": { status: 502, body: "bad gateway" },
      "links.example.com": { status: 200, body: "ok" },
    });
    expect(await setWorkersDevCore(w.deps, { installId: INSTALL_ID, enabled: false })).toEqual({
      enabled: false,
      servedBy: "links.example.com",
    });
    expect(w.probes).toEqual(["broken.example.com", "links.example.com"]);
    expect(w.subdomainCalls).toEqual([
      { name: "cut", args: { enabled: false, previews_enabled: true } },
    ]);
    expect(await stored()).toBe(0);
    expect(await servedDomain()).toBe("links.example.com");
    // The admin decides from now on, and the domain that answered is live.
    const after = await env.DB.prepare("SELECT workers_dev_choice FROM installs").first();
    expect(after).toEqual({ workers_dev_choice: "manual" });
    const live = await env.DB.prepare(
      "SELECT name FROM resources WHERE live_at IS NOT NULL ORDER BY rowid",
    ).all<{ name: string }>();
    expect(live.results.map((r) => r.name)).toEqual(["links.example.com"]);

    // Back on: no domain check needed.
    const again = world();
    expect(await setWorkersDevCore(again.deps, { installId: INSTALL_ID, enabled: true })).toEqual({
      enabled: true,
      servedBy: null,
    });
    expect(again.probes).toEqual([]);
    expect(again.subdomainCalls).toEqual([
      { name: "cut", args: { enabled: true, previews_enabled: true } },
    ]);
    expect(await stored()).toBe(1);
  });

  it(`probes at most ${MAX_DOMAIN_PROBES} domains`, async () => {
    for (const [i, host] of ["a", "b", "c", "d"].entries()) {
      await addDomain(`01${i}`, `${host}.example.com`);
    }
    const w = world({ "d.example.com": { status: 200, body: "ok" } });
    await expect(
      setWorkersDevCore(w.deps, { installId: INSTALL_ID, enabled: false }),
    ).rejects.toThrow("None of this app's domains answered");
    expect(w.probes).toHaveLength(MAX_DOMAIN_PROBES);
  });

  it("changes nothing when the choice is already stored", async () => {
    const w = world();
    expect(await setWorkersDevCore(w.deps, { installId: INSTALL_ID, enabled: true })).toEqual({
      enabled: true,
      servedBy: null,
    });
    expect(w.subdomainCalls).toEqual([]);
  });

  it("refuses while a job of the install runs, and for a self-deploying app", async () => {
    await addDomain("01A", "links.example.com");
    const w = world({ "links.example.com": { status: 200, body: "ok" } });
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('j1', ?1, 'update', 'running')",
    )
      .bind(INSTALL_ID)
      .run();
    await expect(
      setWorkersDevCore(w.deps, { installId: INSTALL_ID, enabled: false }),
    ).rejects.toThrow("A job of this app is running");
    await env.DB.prepare("UPDATE jobs SET status = 'succeeded'").run();
    await env.DB.prepare("UPDATE installs SET build_kind = 'self-deploying'").run();
    await expect(
      setWorkersDevCore(w.deps, { installId: INSTALL_ID, enabled: false }),
    ).rejects.toThrow("The app's own installer decides");
    expect(w.subdomainCalls).toEqual([]);
  });
});
