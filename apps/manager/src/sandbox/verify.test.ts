import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { catalogManifestCacheKey, getCatalogManifest } from "../catalog/app-manifest.server";
import { baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { CATALOG_MANIFEST_URL, publishedCatalog, sandboxIndexApp } from "../test/fake-sandbox";
import { verifyBuiltManifest, verifyCatalogManifest } from "./verify";

const sandboxCatalog = baseCatalog({ install: { ...baseCatalog().install, tier: "sandbox" } });
const PIN = sandboxCatalog.source.sha;

describe("verifyCatalogManifest", () => {
  it("accepts the published manifest of a sandbox entry", async () => {
    const { bytes, digest } = await publishedCatalog(sandboxCatalog);
    const catalog = await verifyCatalogManifest(bytes, { slug: "cut", pin: PIN, digest });
    expect(catalog).toEqual(sandboxCatalog);
  });

  it("refuses another digest, slug, tier, or pin", async () => {
    const { bytes, digest } = await publishedCatalog(sandboxCatalog);
    await expect(
      verifyCatalogManifest(bytes, { slug: "cut", pin: PIN, digest: "0".repeat(64) }),
    ).rejects.toThrow(/does not match the catalog index/);
    await expect(verifyCatalogManifest(bytes, { slug: "other", pin: PIN, digest })).rejects.toThrow(
      /is for "cut", not "other"/,
    );
    await expect(
      verifyCatalogManifest(bytes, { slug: "cut", pin: "f".repeat(40), digest }),
    ).rejects.toThrow(/pins .* the catalog index f+/);
    const artifactTier = await publishedCatalog(baseCatalog());
    await expect(
      verifyCatalogManifest(artifactTier.bytes, {
        slug: "cut",
        pin: PIN,
        digest: artifactTier.digest,
      }),
    ).rejects.toThrow(/artifact tier entry, not a sandbox tier entry/);
  });
});

describe("verifyBuiltManifest", () => {
  it("accepts an unsigned build of the pin that carries the catalog manifest", async () => {
    const fixture = await buildArtifactFixture({ keyId: "unsigned", catalog: sandboxCatalog });
    const manifest = await verifyBuiltManifest(fixture.manifestBytes, {
      slug: "cut",
      version: "1.0.0",
      pin: PIN,
      digest: fixture.digest,
      catalog: sandboxCatalog,
    });
    expect(manifest.keyId).toBe("unsigned");
  });

  it("refuses another version or a build of an artifact tier entry", async () => {
    const fixture = await buildArtifactFixture({ keyId: "unsigned", catalog: sandboxCatalog });
    const expected = {
      slug: "cut",
      version: "1.0.1",
      pin: PIN,
      digest: fixture.digest,
      catalog: sandboxCatalog,
    };
    await expect(verifyBuiltManifest(fixture.manifestBytes, expected)).rejects.toThrow(
      /version 1.0.0, the catalog lists 1.0.1/,
    );
    const artifact = await buildArtifactFixture({ keyId: "unsigned" });
    await expect(
      verifyBuiltManifest(artifact.manifestBytes, {
        ...expected,
        version: "1.0.0",
        digest: artifact.digest,
      }),
    ).rejects.toThrow(/does not carry a sandbox tier catalog manifest/);
  });
});

describe("getCatalogManifest for a sandbox entry", () => {
  it("loads the published catalog manifest once, then reads it from KV", async () => {
    const fixture = await buildArtifactFixture({ keyId: "unsigned", catalog: sandboxCatalog });
    const app = await sandboxIndexApp(fixture);
    const { bytes } = await publishedCatalog(sandboxCatalog);
    let fetches = 0;
    const fetch = async (url: string) => {
      fetches += 1;
      return url === CATALOG_MANIFEST_URL
        ? new Response(new Uint8Array(bytes))
        : new Response("", { status: 404 });
    };
    const first = await getCatalogManifest(env, app, { fetch });
    expect(first).toEqual({ ok: true, catalog: sandboxCatalog, manifest: null });
    const second = await getCatalogManifest(env, app, { fetch });
    expect(second.ok).toBe(true);
    expect(fetches).toBe(1);
    expect(
      await env.KV.get(catalogManifestCacheKey(app.build?.manifestDigest ?? "")),
    ).not.toBeNull();
  });

  it("explains an entry that has neither a release nor a catalog manifest", async () => {
    const fixture = await buildArtifactFixture();
    const { artifacts: _a, ...rest } = fixture.index;
    const read = await getCatalogManifest(env, { ...rest, tier: "self-deploying" });
    expect(read).toEqual({
      ok: false,
      error: "cut 1.0.0 lists neither a release nor a catalog manifest to install it from.",
    });
  });
});
