import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { recordFixtureRevision, setInstallRelease } from "../test/recorded-revision";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { readOpenPaths } from "./open-path.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("where an installed app's Open button goes", () => {
  it("is the release's openPath, or the root without one", async () => {
    await seedInstall();
    const plain = await buildArtifactFixture();
    await setInstallRelease(INSTALL_ID, plain);
    expect(await readOpenPaths(env.DB)).toEqual(new Map());
    const withPath = await buildArtifactFixture({ catalog: { openPath: "/dashboard" } });
    await setInstallRelease(INSTALL_ID, withPath);
    expect(await readOpenPaths(env.DB)).toEqual(new Map([[INSTALL_ID, "/dashboard"]]));
    expect(await readOpenPaths(env.DB, INSTALL_ID)).toEqual(new Map([[INSTALL_ID, "/dashboard"]]));
    expect(await readOpenPaths(env.DB, "another")).toEqual(new Map());
    // Only installed apps have somewhere to open.
    await env.DB.prepare("UPDATE installs SET status = 'updating'").run();
    expect(await readOpenPaths(env.DB)).toEqual(new Map());
  });

  it("follows the revision recorded for the release, signed with its key", async () => {
    const f = await buildArtifactFixture({
      catalog: { openPath: "/dashboard" },
      revision: { openPath: "/admin/" },
    });
    await seedInstall();
    await setInstallRelease(INSTALL_ID, f);
    expect(await readOpenPaths(env.DB)).toEqual(new Map([[INSTALL_ID, "/dashboard"]]));
    await recordFixtureRevision(f);
    expect(await readOpenPaths(env.DB)).toEqual(new Map([[INSTALL_ID, "/admin/"]]));
    // A revision under another key than the release's does not apply.
    await env.DB.prepare("UPDATE catalog_revisions SET key_id = 'other'").run();
    expect(await readOpenPaths(env.DB)).toEqual(new Map([[INSTALL_ID, "/dashboard"]]));
  });

  it("drops a revision's removal of the path back to the root", async () => {
    const f = await buildArtifactFixture({
      catalog: { openPath: "/dashboard" },
      revision: { openPath: undefined },
    });
    await seedInstall();
    await setInstallRelease(INSTALL_ID, f);
    await recordFixtureRevision(f);
    expect(await readOpenPaths(env.DB)).toEqual(new Map());
  });

  it("reads a self-deploying install's catalog manifest", async () => {
    await seedInstall({
      manifestJson: JSON.stringify({ ...baseCatalog(), openPath: "/app" }),
    });
    await env.DB.prepare("UPDATE installs SET build_kind = 'self-deploying'").run();
    expect(await readOpenPaths(env.DB)).toEqual(new Map([[INSTALL_ID, "/app"]]));
  });

  it("opens the root for a path the schema refuses, or a record it cannot read", async () => {
    await seedInstall({
      manifestJson: JSON.stringify({ catalog: { openPath: "//evil.example/x" } }),
    });
    expect(await readOpenPaths(env.DB)).toEqual(new Map());
    await env.DB.prepare("UPDATE installs SET manifest_json = '{not json'").run();
    expect(await readOpenPaths(env.DB)).toEqual(new Map());
  });
});
