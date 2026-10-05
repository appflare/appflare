import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { jobEventOf } from "./events.server";
import { renderMessage } from "./messages";

/**
 * What a finished job's notification calls the app. An install records its
 * manifest (and with it the app's name) only when it finishes, so a failed
 * one goes by the name its install job recorded when it started: the same
 * name, and the same Worker name beside it where needed, as a finished one.
 */

const MANIFEST = JSON.stringify({
  version: "1.0.0",
  worker: { migrations: [] },
  catalog: { name: "Memory Note" },
});

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

/** Install `i1` of the app `memory-note` as the Worker `appflare-rc-fail`. */
async function seed(opts: { status: string; manifest: boolean }): Promise<void> {
  await seedInstall({ status: opts.status, manifestJson: MANIFEST });
  await env.DB.prepare(
    "UPDATE installs SET app_slug = 'memory-note', worker_name = 'appflare-rc-fail', manifest_json = ?2 WHERE id = ?1",
  )
    .bind(INSTALL_ID, opts.manifest ? MANIFEST : null)
    .run();
}

async function job(
  id: string,
  kind: string,
  status: "succeeded" | "failed",
  input: Record<string, unknown>,
  installId = INSTALL_ID,
): Promise<string> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at, finished_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 2)`,
  )
    .bind(id, installId, kind, status, JSON.stringify(input))
    .run();
  return id;
}

const INSTALL_INPUT = { slug: "memory-note", appName: "Memory Note", version: "1.0.0" };

async function message(jobId: string) {
  const event = await jobEventOf(env.DB, jobId);
  if (event === null) throw new Error("no event");
  return { event, text: renderMessage(event.facts, null) };
}

describe("the app's name in a finished job's notification", () => {
  it("names a failed install as a finished one, not by its catalog id", async () => {
    await seed({ status: "failed", manifest: false });
    const failed = await message(await job("j-fail", "install", "failed", INSTALL_INPUT));
    expect(failed.text.title).toBe("Install failed: Memory Note");
    expect(failed.text.lines.join(" ")).not.toContain("memory-note");

    // The same install, finished: the same name.
    await env.DB.prepare(
      "UPDATE installs SET status = 'installed', manifest_json = ?2 WHERE id = ?1",
    )
      .bind(INSTALL_ID, MANIFEST)
      .run();
    await env.DB.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = 'j-fail'").run();
    const done = await message("j-fail");
    expect(done.text.title).toBe("Installed Memory Note");
    expect(done.event.facts).toMatchObject({
      app: { app: "Memory Note", instance: "Memory Note", workerName: "appflare-rc-fail" },
    });
  });

  it("adds the Worker name to a failed install's name where another install reads the same", async () => {
    await seed({ status: "failed", manifest: false });
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
         manifest_json, installed_at, updated_at)
       VALUES ('i2', 'memory-note', 'appflare-rc-again2', '1.0.0', 'x', 'installed', ?1, 1, 1)`,
    )
      .bind(MANIFEST)
      .run();
    const failed = await message(await job("j-fail", "install", "failed", INSTALL_INPUT));
    expect(failed.text.title).toBe("Install failed: Memory Note (appflare-rc-fail)");

    // And the other install's success names itself the same way.
    await job("j-ok", "install", "succeeded", INSTALL_INPUT, "i2");
    expect((await message("j-ok")).text.title).toBe("Installed Memory Note (appflare-rc-again2)");
  });

  it("names a failed uninstall of an install that never finished by its install job's name", async () => {
    await seed({ status: "failed", manifest: false });
    await job("j-install", "install", "failed", INSTALL_INPUT);
    const failed = await message(await job("j-un", "uninstall", "failed", {}));
    expect(failed.text.title).toBe("Uninstall failed: Memory Note");

    const replaced = await message(
      await job("j-replace", "uninstall", "failed", { replacedBy: "i9" }),
    );
    expect(replaced.text.title).toBe(
      "Removing what the unfinished install of Memory Note left failed",
    );
  });

  it("names a failed update as an applied one", async () => {
    await seed({ status: "installed", manifest: true });
    const input = { fromVersion: "1.0.0", version: "1.1.0" };
    const failed = await message(await job("j-up-fail", "update", "failed", input));
    const applied = await message(await job("j-up-ok", "update", "succeeded", input));
    expect(failed.text.title).toBe("Update failed: Memory Note");
    expect(applied.text.title).toBe("Updated Memory Note");
  });

  it("keeps a display name, and falls back to the slug for an install from an older version", async () => {
    await seed({ status: "failed", manifest: false });
    await env.DB.prepare("UPDATE installs SET display_name = 'Notes' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    const named = await message(await job("j-fail", "install", "failed", INSTALL_INPUT));
    expect(named.text.title).toBe("Install failed: Notes");
    expect(named.text.lines[0]).toContain("Installing Memory Note 1.0.0 as Notes failed.");

    await env.DB.prepare("UPDATE installs SET display_name = NULL WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    await env.DB.prepare("DELETE FROM jobs").run();
    // Recorded before the install job carried the app's name.
    const older = await message(await job("j-old", "install", "failed", { slug: "memory-note" }));
    expect(older.text.title).toBe("Install failed: memory-note");
  });
});
