import { describe, expect, it } from "vitest";
import { buildArtifactFixture, MANIFEST_URL, ZIP_URL } from "../../test/artifact-fixture";
import { redirectingArtifactHost, STORAGE_URL } from "../../test/redirecting-host";
import {
  ArtifactError,
  ArtifactFetchError,
  artifactReader,
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

  it("reads format 1, D1 SQL grouped by binding, and asks to update Appflare for a later format", async () => {
    const d1 = await buildArtifactFixture({
      bindings: [{ type: "d1", name: "DB" }],
      d1: { DB: [{ name: "0001_init.sql", content: "CREATE TABLE t (id);" }] },
      d1Schema: { DB: [{ name: "schema.sql", content: "CREATE TABLE IF NOT EXISTS u (id);" }] },
    });
    const manifest = await verifyArtifactManifest(
      d1.manifestBytes,
      d1.signature,
      expected(d1),
      d1.keys,
    );
    expect(manifest.format).toBe(1);
    expect(manifest.d1.DB?.migrations.map((f) => f.name)).toEqual(["0001_init.sql"]);
    expect(manifest.d1.DB?.schema.map((f) => f.name)).toEqual(["schema.sql"]);
    expect(manifest.d1.DB?.postDeploy).toEqual([]);

    const baseline = await buildArtifactFixture({
      bindings: [{ type: "d1", name: "DB" }],
      d1Baseline: { DB: { name: "schema.sql", content: "CREATE TABLE t (id);" } },
    });
    const withBaseline = await verifyArtifactManifest(
      baseline.manifestBytes,
      baseline.signature,
      expected(baseline),
      baseline.keys,
    );
    expect(withBaseline.d1.DB?.baseline?.name).toBe("schema.sql");

    const assetsOnly = await buildArtifactFixture({
      assetsOnly: true,
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
    });
    const files = await verifyArtifactManifest(
      assetsOnly.manifestBytes,
      assetsOnly.signature,
      expected(assetsOnly),
      assetsOnly.keys,
    );
    expect(files.worker.mainModule).toBeUndefined();

    const future = await buildArtifactFixture({
      tweak: (m) => {
        (m as { format: number }).format = 7;
      },
    });
    await expect(
      verifyArtifactManifest(future.manifestBytes, future.signature, expected(future), future.keys),
    ).rejects.toThrow(
      "the artifact is format 7, and this version of Appflare reads format 1; update Appflare in [Settings > Updates](/settings/updates#appflare), then try again",
    );

    const earlier = await buildArtifactFixture({
      tweak: (m) => {
        (m as { format: number }).format = 6;
      },
    });
    await expect(
      verifyArtifactManifest(
        earlier.manifestBytes,
        earlier.signature,
        expected(earlier),
        earlier.keys,
      ),
    ).rejects.toThrow(
      "the artifact is format 6: the app's release was built for an earlier version of Appflare and needs to be packed again by its catalog",
    );
  });

  it("refuses an artifact written in an earlier format, which no version reads now", async () => {
    const old = await buildArtifactFixture({
      tweak: (m) => {
        (m as { format: number }).format = 0;
      },
    });
    await expect(
      verifyArtifactManifest(old.manifestBytes, old.signature, expected(old), old.keys),
    ).rejects.toThrow("the artifact is format 0, which no version of Appflare reads");
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

describe("artifactReader", () => {
  const assets = Array.from({ length: 30 }, (_, i) => ({
    route: `/f${i}.txt`,
    content: `file ${i}`,
  }));

  it("reads 30 adjacent files with one range request and follows the redirect once", async () => {
    const f = await buildArtifactFixture({ assets });
    const host = redirectingArtifactHost(f);
    const hops: Array<RequestRedirect | undefined> = [];
    const reader = artifactReader(async (url, init) => {
      hops.push(init?.redirect);
      return host.serve(url, init) ?? new Response(null, { status: 404 });
    }, ZIP_URL);
    const files = f.manifest.assets.files;
    const got = await reader.read(files);
    expect(got.map((b) => new TextDecoder().decode(b))).toEqual(assets.map((a) => a.content));
    const first = files[0];
    const last = files.at(-1);
    if (first === undefined || last === undefined) throw new Error("no files");
    const range = `bytes=${first.offset}-${last.offset + last.size - 1}`;
    expect(host.requests).toEqual([
      { url: ZIP_URL, range },
      { url: STORAGE_URL, range },
    ]);
    // The reader follows redirects itself, so a counting fetch sees every hop.
    expect(hops).toEqual(["manual", "manual"]);
    expect(reader.ranges).toBe(1);
  });

  it("sends later ranges straight to the resolved URL", async () => {
    const big = "x".repeat(300 * 1024);
    const f = await buildArtifactFixture({
      assets: [
        { route: "/a.txt", content: "a" },
        { route: "/big.bin", content: big },
        { route: "/b.txt", content: "b" },
        { route: "/c.txt", content: "c" },
      ],
    });
    const host = redirectingArtifactHost(f);
    const reader = artifactReader(
      async (url, init) => host.serve(url, init) ?? new Response(null, { status: 404 }),
      ZIP_URL,
    );
    // Cloudflare already has big.bin, so a.txt and b.txt are more than a gap apart.
    const wanted = f.manifest.assets.files.filter((file) => file.route !== "/big.bin");
    const got = await reader.read(wanted);
    expect(got.map((b) => new TextDecoder().decode(b))).toEqual(["a", "b", "c"]);
    expect(host.requests.map((r) => r.url)).toEqual([ZIP_URL, STORAGE_URL, STORAGE_URL]);
    expect(reader.ranges).toBe(2);
  });

  it("uses the final URL a redirect-following wrapper reports", async () => {
    const f = await buildArtifactFixture({ assets });
    const urls: string[] = [];
    const reader = artifactReader(async (url, init) => {
      urls.push(url);
      const res = f.serve(ZIP_URL, init) ?? new Response(null, { status: 404 });
      Object.defineProperty(res, "url", { value: STORAGE_URL });
      return res;
    }, ZIP_URL);
    const [one, two] = f.manifest.assets.files;
    if (one === undefined || two === undefined) throw new Error("no files");
    await reader.read([one]);
    await reader.read([two]);
    expect(urls).toEqual([ZIP_URL, STORAGE_URL]);
  });

  it("checks every file's sha256 and refuses a host that ignores Range", async () => {
    const f = await buildArtifactFixture({ assets });
    const [one, two] = f.manifest.assets.files;
    if (one === undefined || two === undefined) throw new Error("no files");
    const serve = async (url: string, init?: RequestInit) =>
      f.serve(url, init) ?? new Response(null, { status: 404 });
    await expect(
      artifactReader(serve, ZIP_URL).read([one, { ...two, sha256: "0".repeat(64) }]),
    ).rejects.toThrow(/does not match the manifest/);
    const ignored = await artifactReader(async () => new Response(new Uint8Array(f.zip)), ZIP_URL)
      .read([one])
      .catch((e) => e);
    expect(ignored).toBeInstanceOf(ArtifactFetchError);
    expect(ignored.message).toMatch(/ignored the Range request/);
    expect(ignored.retryable).toBe(false);
  });

  it("marks the runtime's subrequest-limit error as not retryable, other network errors as retryable", async () => {
    const f = await buildArtifactFixture({ assets });
    const [one] = f.manifest.assets.files;
    if (one === undefined) throw new Error("no files");
    const failWith = (message: string) =>
      artifactReader(async () => {
        throw new Error(message);
      }, ZIP_URL)
        .read([one])
        .catch((e) => e);
    const limit = await failWith("Too many subrequests by single Worker invocation.");
    expect(limit).toBeInstanceOf(ArtifactFetchError);
    expect(limit.retryable).toBe(false);
    expect((await failWith("connection reset")).retryable).toBe(true);
  });

  it("refuses a redirect to plain HTTP", async () => {
    const f = await buildArtifactFixture({ assets });
    const [one] = f.manifest.assets.files;
    if (one === undefined) throw new Error("no files");
    const error = await artifactReader(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://insecure.test/" } }),
      ZIP_URL,
    )
      .read([one])
      .catch((e) => e);
    expect(error).toBeInstanceOf(ArtifactFetchError);
    expect(error.message).toMatch(/not HTTPS/);
  });
});
