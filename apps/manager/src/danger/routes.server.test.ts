import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import { ACC, TOKEN } from "../test/fake-account";
import {
  ACCOUNT_NAME,
  type FakeRemovalOptions,
  fakeRemovalAccount,
  MANAGER_WORKER,
} from "../test/fake-removal";
import { fakeSelf } from "../test/fake-self";
import { seedInstall } from "../test/seed-install";
import { REMOVE_PATH, ROTATE_PATH } from "./danger";
import { OWNER_ONLY } from "./errors";
import { markRemovalStarted, removalInProgress } from "./removal-flag";
import { handleRemoveAppflare, handleRotateAuthSecret } from "./routes.server";

/**
 * The two form endpoints: who may post, what they check before anything is
 * deleted, the streamed removal page, and the manager Worker deleted only
 * after that page is complete.
 */

const ORIGIN = "https://appflare.ada.workers.dev";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: MANAGER_WORKER,
  });
  const at = new Date("2026-09-01T00:00:00Z");
  await createDb(env.DB)
    .insert(user)
    .values([
      {
        id: "owner",
        name: "Ada",
        email: "ada@example.com",
        role: "admin",
        isOwner: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "admin",
        name: "Bob",
        email: "bob@example.com",
        role: "admin",
        createdAt: at,
        updatedAt: at,
      },
    ]);
});

function post(path: string, confirm: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin", ...headers },
    body: new URLSearchParams({ confirm }),
  });
}

function setup(options: FakeRemovalOptions & { userId?: string | null; self?: boolean } = {}) {
  const account = fakeRemovalAccount(options);
  const pending: Promise<unknown>[] = [];
  const dangerEnv = {
    DB: env.DB,
    CF_API_TOKEN: TOKEN,
    ...(options.self === false
      ? {}
      : { SELF: fakeSelf({ CF_API_TOKEN: TOKEN }, { fetch: account.fetch }) }),
  };
  const deps = {
    userId: async () => (options.userId === undefined ? "owner" : options.userId),
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    fetch: account.fetch,
    sleep: async () => {},
  };
  return { account, dangerEnv, deps, settle: () => Promise.all(pending) };
}

describe("handleRemoveAppflare", () => {
  it("refuses a post from another site before reading anything", async () => {
    const s = setup();
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME, { "sec-fetch-site": "cross-site" }),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(403);
    expect(s.account.calls).toEqual([]);
  });

  it("refuses an admin who is not the owner", async () => {
    const s = setup({ userId: "admin" });
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(OWNER_ONLY.replace("'", "&#39;"));
    expect(s.account.calls).toEqual([]);
  });

  it("refuses a name that is not the account's, deleting nothing", async () => {
    const s = setup();
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, "Someone else"),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Nothing was deleted");
    expect(s.account.deletes()).toEqual([]);
  });

  it("refuses while a job runs", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, input_json) VALUES ('j1', 'install', 'running', '{}')",
    ).run();
    const s = setup();
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("/jobs/j1");
    expect(s.account.deletes()).toEqual([]);
  });

  it("refuses while an app has an external domain, naming it and its Domains tab", async () => {
    await seedInstall({
      resources: [{ kind: "custom_hostname", name: "shop.example.com", cfId: "ch-1" }],
    });
    const s = setup();
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain("Remove these external domains first, or their visitors lose the site");
    expect(html).toContain("cut (shop.example.com; /apps/i1?tab=domains)");
    expect(s.account.deletes()).toEqual([]);
  });

  it("does not count an external domain that was removed", async () => {
    await seedInstall({
      resources: [{ kind: "custom_hostname", name: "shop.example.com", cfId: "ch-1" }],
    });
    await env.DB.prepare("UPDATE resources SET deleted_at = 1").run();
    const s = setup();
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(200);
    await response.text();
    await s.settle();
    expect(s.account.deletes().at(-1)).toBe(`DELETE /a/workers/scripts/${MANAGER_WORKER}`);
  });

  it("streams each step, then deletes the manager Worker last, after the page is complete", async () => {
    const s = setup({ objects: 2 });
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain("Removing Appflare from Ada&#39;s Account");
    expect(html).toContain("Delete the R2 bucket appflare-builds");
    expect(html).toContain("Delete the manager&#39;s D1 database");
    expect(html).toContain("deletes itself");
    expect(html).toMatch(/<\/html>\n$/);
    // Self-contained: no scripts, no stylesheets or images to load.
    expect(html).not.toMatch(/<script|<link|<img|src=/);

    await s.settle();
    const deletes = s.account.deletes();
    expect(deletes.at(-1)).toBe(`DELETE /a/workers/scripts/${MANAGER_WORKER}`);
    expect(deletes.at(-2)).toBe("DELETE /a/d1/database/d1-manager");
    expect(deletes[0]).toBe("DELETE /a/r2/buckets/appflare-builds/objects/builds/b0.zip");
  });

  it("keeps the manager Worker when a step fails, and says how to finish", async () => {
    const s = setup({
      fail: { "DELETE /a/d1/database/d1-manager": { status: 500, code: 7500, message: "boom" } },
    });
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    const html = await response.text();
    await s.settle();
    expect(html).toContain("The removal stopped");
    expect(html).toContain("boom");
    expect(html).toContain("Cloudflare Access protection was off");
    expect(s.account.deletes()).not.toContain(`DELETE /a/workers/scripts/${MANAGER_WORKER}`);
    // Jobs may start again.
    expect(await removalInProgress(env.DB)).toBeNull();
  });

  it("marks the removal as running, so no job starts meanwhile", async () => {
    const s = setup();
    let markedDuringRun: string | null = null;
    const response = await handleRemoveAppflare(post(REMOVE_PATH, ACCOUNT_NAME), s.dangerEnv, {
      ...s.deps,
      sleep: async () => {
        markedDuringRun = await removalInProgress(env.DB);
      },
    });
    await response.text();
    await s.settle();
    expect(markedDuringRun).not.toBeNull();
  });

  it("refuses a second removal while one runs", async () => {
    await markRemovalStarted(env.DB, new Date());
    const s = setup();
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    expect(response.status).toBe(409);
    expect(s.account.deletes()).toEqual([]);
  });

  it("stops and keeps everything when the browser goes away before the database is deleted", async () => {
    const s = setup();
    const response = await handleRemoveAppflare(
      post(REMOVE_PATH, ACCOUNT_NAME),
      s.dangerEnv,
      s.deps,
    );
    await response.body?.cancel();
    await s.settle();
    expect(s.account.deletes()).not.toContain("DELETE /a/d1/database/d1-manager");
    expect(s.account.deletes()).not.toContain(`DELETE /a/workers/scripts/${MANAGER_WORKER}`);
    expect(await removalInProgress(env.DB)).toBeNull();
  });
});

describe("handleRotateAuthSecret", () => {
  it("needs the typed word", async () => {
    const s = setup();
    const response = await handleRotateAuthSecret(post(ROTATE_PATH, "yes"), s.dangerEnv, s.deps);
    expect(response.status).toBe(400);
    expect(s.account.calls).toEqual([]);
  });

  it("refuses an admin who is not the owner", async () => {
    const s = setup({ userId: "admin" });
    const response = await handleRotateAuthSecret(post(ROTATE_PATH, "rotate"), s.dangerEnv, s.deps);
    expect(response.status).toBe(403);
    expect(s.account.calls).toEqual([]);
  });

  it("refuses a post without a same-origin proof", async () => {
    const s = setup();
    const request = new Request(`${ORIGIN}${ROTATE_PATH}`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: new URLSearchParams({ confirm: "rotate" }),
    });
    expect((await handleRotateAuthSecret(request, s.dangerEnv, s.deps)).status).toBe(403);
  });

  it("rotates and answers with the signed-out page", async () => {
    const s = setup();
    const response = await handleRotateAuthSecret(post(ROTATE_PATH, "rotate"), s.dangerEnv, s.deps);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Everyone is signed out");
    expect(html).toContain('href="/login"');
    expect(s.account.calls).toEqual([`PUT /a/workers/scripts/${MANAGER_WORKER}/secrets`]);
  });
});
