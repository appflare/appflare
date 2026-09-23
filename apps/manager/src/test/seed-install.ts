import { env } from "cloudflare:workers";
import { CATALOG_INDEX_KEY } from "../catalog/index.server";
import { createDb } from "../db/client";
import { SETTING, writeSettings } from "../db/settings";
import type { ArtifactFixture } from "./artifact-fixture";
import { ACC, SUBDOMAIN } from "./fake-account";

/**
 * Test-only: an installed app in the local D1, as an install job leaves it,
 * without running one. Install `i1`, Worker `cut`, version 1.0.0.
 */

export const INSTALL_ID = "i1";
export const OLD_VERSION = "99999999-8888-4777-8666-555555555555";
export const OLD_MANIFEST = JSON.stringify({ version: "1.0.0", worker: { migrations: [] } });

export interface SeedResource {
  kind: string;
  binding?: string | null;
  name: string;
  cfId?: string | null;
}

export async function seedInstall(
  opts: {
    status?: string;
    version?: string;
    currentVersionId?: string;
    manifestJson?: string;
    resources?: SeedResource[];
  } = {},
): Promise<void> {
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       artifact_digest, pin_sha, status, current_version_id, config_json, manifest_json,
       installed_at, updated_at)
     VALUES (?1, 'cut', 'cut', 'cut', ?2, 'https://artifacts.test/cut/old.zip', ?3, 'oldsha',
       ?4, ?5, '{"HOME_PAGE":"admin"}', ?6, 1, 1)`,
  )
    .bind(
      INSTALL_ID,
      opts.version ?? "1.0.0",
      "0".repeat(64),
      opts.status ?? "installed",
      opts.currentVersionId ?? OLD_VERSION,
      opts.manifestJson ?? OLD_MANIFEST,
    )
    .run();
  for (const r of opts.resources ?? []) {
    const key = r.binding ?? r.name;
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)`,
    )
      .bind(
        `${INSTALL_ID}:${r.kind}:${key}`,
        INSTALL_ID,
        r.kind,
        r.binding ?? null,
        r.name,
        r.cfId ?? null,
      )
      .run();
  }
}

/** Caches a catalog index that lists the fixture's app at its version. */
export async function cacheIndex(fixture: ArtifactFixture): Promise<void> {
  await env.KV.put(
    CATALOG_INDEX_KEY,
    JSON.stringify({ generatedAt: "2026-09-23T00:00:00.000Z", apps: [fixture.index] }),
  );
}
