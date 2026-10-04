import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { recordProtectedInstall } from "../test/protected-install";
import { recordFixtureRevision, setInstallRelease } from "../test/recorded-revision";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import {
  requiredButUnprotected,
  storedBypassPaths,
  storedCatalogAccess,
} from "./stored-access.server";

const AUTH = "auth-secret-0123456789abcdef0123456789";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("an installed app's Access settings", () => {
  it("come from the revision recorded for its release, else from the release", async () => {
    const f = await buildArtifactFixture({
      catalog: { access: { bypass: ["/s/*"] } },
      revision: { requires: ["access"], access: { mode: "required", bypass: ["/x/*"] } },
    });
    await seedInstall();
    await setInstallRelease(INSTALL_ID, f);
    const stored = {
      manifestJson: new TextDecoder().decode(f.manifestBytes),
      artifactDigest: f.digest,
    };
    const orm = createDb(env.DB);
    expect(await storedBypassPaths(orm, stored)).toEqual(["/s/*"]);
    expect(await requiredButUnprotected(env.DB)).toEqual(new Set());
    await recordFixtureRevision(f);
    expect(await storedCatalogAccess(orm, stored)).toEqual({
      access: { mode: "required", bypass: ["/x/*"] },
    });
    expect(await storedBypassPaths(orm, stored)).toEqual(["/x/*"]);
    // Now required, and not protected: it needs an admin.
    expect(await requiredButUnprotected(env.DB)).toEqual(new Set([INSTALL_ID]));
    // A revision signed with another key than the release's does not apply.
    await env.DB.prepare("UPDATE catalog_revisions SET key_id = 'other'").run();
    expect(await requiredButUnprotected(env.DB)).toEqual(new Set());
    await env.DB.prepare("UPDATE catalog_revisions SET key_id = ?1").bind(f.manifest.keyId).run();
    // Protected, or busy with a job: nothing to say.
    await recordProtectedInstall({ installId: INSTALL_ID, authSecret: AUTH, secret: "s" });
    expect(await requiredButUnprotected(env.DB)).toEqual(new Set());
    await env.DB.prepare("DELETE FROM install_access").run();
    await env.DB.prepare("UPDATE installs SET status = 'updating'").run();
    expect(await requiredButUnprotected(env.DB)).toEqual(new Set());
  });

  it("finds them among many installs in one query, released or revised as required", async () => {
    // Its own release: same bytes would share the revised release's digest.
    const plain = await buildArtifactFixture({ catalog: { summary: "A release of its own." } });
    const required = await buildArtifactFixture({
      catalog: { requires: ["access"], access: { mode: "required" } },
    });
    const revised = await buildArtifactFixture({
      revision: { requires: ["access"], access: { mode: "required" } },
    });
    await recordFixtureRevision(revised);
    const fixtures = [plain, required, revised];
    const statements = Array.from({ length: 150 }, (_, i) => {
      const f = fixtures[i % 3] ?? plain;
      return env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, artifact_digest, status, manifest_json, installed_at, updated_at)
         VALUES (?1, 'cut', ?1, ?1, '1.0.0', 'https://artifacts.test/cut.zip', ?2, 'installed', ?3, 1, 1)`,
      ).bind(`i${String(i).padStart(3, "0")}`, f.digest, new TextDecoder().decode(f.manifestBytes));
    });
    await env.DB.batch(statements);
    const found = await requiredButUnprotected(env.DB);
    expect(found.size).toBe(100);
    expect(found.has("i001")).toBe(true);
    expect(found.has("i002")).toBe(true);
    expect(found.has("i000")).toBe(false);
  });
});
