import { describe, expect, it } from "vitest";
import { buildArtifactFixture, MANIFEST_URL, ZIP_URL } from "../../test/artifact-fixture";
import {
  ArtifactError,
  ArtifactFetchError,
  fetchArtifactFile,
  fetchWhole,
  sha256Hex,
  verifyArtifactManifest,
} from "./artifact";

const expected = (f: { digest: string }) => ({ slug: "cut", version: "1.0.0", digest: f.digest });

describe("verifyArtifactManifest", () => {
  it("accepts a manifest signed by a trusted key whose digest matches the index", async () => {
    const f = await buildArtifactFixture();
    const manifest = await verifyArtifactManifest(
      f.manifestBytes,
      f.signature,
      expected(f),
      f.keys,
    );
    expect(manifest.app).toBe("cut");
    expect(manifest.catalog.secrets[0]?.name).toBe("ADMIN_PASSWORD");
  });

  it("rejects a digest that differs from the catalog index", async () => {
    const f = await buildArtifactFixture();
    await expect(
      verifyArtifactManifest(
        f.manifestBytes,
        f.signature,
        { ...expected(f), digest: "0".repeat(64) },
        f.keys,
      ),
    ).rejects.toThrow(/does not match the catalog index/);
  });

  it("rejects an unknown keyId and the unsigned keyId", async () => {
    const f = await buildArtifactFixture({ keyId: "someone-else" });
    await expect(
      verifyArtifactManifest(f.manifestBytes, f.signature, expected(f), [
        { keyId: "test-key", publicKeyBase64: f.keys[0]?.publicKeyBase64 ?? "" },
      ]),
    ).rejects.toThrow(/no trusted signing key matches keyId "someone-else"/);

    const unsigned = await buildArtifactFixture({ keyId: "unsigned" });
    await expect(
      verifyArtifactManifest(
        unsigned.manifestBytes,
        unsigned.signature,
        expected(unsigned),
        unsigned.keys,
      ),
    ).rejects.toThrow(/unsigned/);
  });

  it("rejects a signature from another key", async () => {
    const a = await buildArtifactFixture();
    const b = await buildArtifactFixture();
    await expect(
      verifyArtifactManifest(a.manifestBytes, b.signature, expected(a), a.keys),
    ).rejects.toThrow(ArtifactError);
  });

  it("rejects a slug or version that differs from the request", async () => {
    const f = await buildArtifactFixture({ version: "2.0.0" });
    await expect(
      verifyArtifactManifest(
        f.manifestBytes,
        f.signature,
        { ...expected(f), version: "1.0.0" },
        f.keys,
      ),
    ).rejects.toThrow(/version 2.0.0, the catalog lists 1.0.0/);
    const other = await buildArtifactFixture({
      tweak: (m) => {
        m.catalog.slug = "other";
      },
    });
    await expect(
      verifyArtifactManifest(other.manifestBytes, other.signature, expected(other), other.keys),
    ).rejects.toThrow(/for "other", not "cut"/);
  });
});

describe("fetchArtifactFile", () => {
  it("Range-fetches one file and checks its sha256", async () => {
    const f = await buildArtifactFixture();
    const module = f.manifest.worker.modules[0];
    if (module === undefined) throw new Error("fixture has no module");
    let range: string | null = null;
    const got = await fetchArtifactFile(
      async (url, init) => {
        range = new Headers(init?.headers).get("range");
        return f.serve(url, init) ?? new Response(null, { status: 404 });
      },
      ZIP_URL,
      module,
    );
    expect(range).toBe(`bytes=${module.offset}-${module.offset + module.size - 1}`);
    expect(await sha256Hex(got.bytes)).toBe(module.sha256);
    expect(got.subrequests).toBe(1);
  });

  it("fails on a wrong sha256 and on a host that ignores Range", async () => {
    const f = await buildArtifactFixture();
    const module = f.manifest.worker.modules[0];
    if (module === undefined) throw new Error("fixture has no module");
    const serve = async (url: string, init?: RequestInit) =>
      f.serve(url, init) ?? new Response(null, { status: 404 });
    await expect(
      fetchArtifactFile(serve, ZIP_URL, { ...module, sha256: "0".repeat(64) }),
    ).rejects.toThrow(/does not match the manifest/);
    await expect(
      fetchArtifactFile(async () => new Response(new Uint8Array(f.zip)), ZIP_URL, module),
    ).rejects.toThrow(/ignored the Range request/);
  });

  it("marks 5xx retryable and 404 not", async () => {
    const file = { path: "x", offset: 0, size: 1, sha256: "0".repeat(64) };
    const failWith = (status: number) =>
      fetchArtifactFile(async () => new Response("", { status }), ZIP_URL, file).catch((e) => e);
    const e503 = await failWith(503);
    expect(e503).toBeInstanceOf(ArtifactFetchError);
    expect(e503.retryable).toBe(true);
    const e404 = await failWith(404);
    expect(e404.retryable).toBe(false);
  });

  it("fetchWhole reads a whole small file", async () => {
    const f = await buildArtifactFixture();
    const got = await fetchWhole(
      async (url) => f.serve(url) ?? new Response("", { status: 404 }),
      MANIFEST_URL,
    );
    expect(got.bytes).toEqual(f.manifestBytes);
  });
});
