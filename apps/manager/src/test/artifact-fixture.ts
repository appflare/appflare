import { assetHash } from "@appflare/cf-api";
import type { ArtifactManifest, CatalogManifest, IndexApp, SigningKey } from "@appflare/schema";
import { sha256Hex } from "../jobs/install/artifact";

/**
 * Test-only signed artifact: a byte blob standing in for the STORE zip (files
 * laid out at recorded offsets), a manifest signed with a throwaway Ed25519 key,
 * and a fetch that serves it with Range support. The key is generated per test
 * and injected; the real `signingKeys` are never touched.
 */

export const ZIP_URL = "https://artifacts.test/cut/cut-1.0.0.zip";
export const MANIFEST_URL = "https://artifacts.test/cut/manifest.json";
export const SIG_URL = "https://artifacts.test/cut/manifest.sig";

export interface FixtureFile {
  path: string;
  content: string;
}

export interface ArtifactFixtureOptions {
  keyId?: string;
  version?: string;
  catalog?: Partial<CatalogManifest>;
  bindings?: ArtifactManifest["worker"]["bindings"];
  assets?: Array<{ route: string; content: string }>;
  d1?: Record<string, Array<{ name: string; content: string }>>;
  crons?: string[];
  migrations?: ArtifactManifest["worker"]["migrations"];
  /**
   * More modules for the Worker, laid out right after `worker.js` as the
   * packer writes a Worker's modules; each is `chunk-<n>.js`.
   */
  extraModules?: Array<{ content: string }>;
  /**
   * Makes the app one of several Workers (format 2): the fixture's Worker is
   * the primary one, named `app` in the entry, and these are the others, in
   * the entry's order. Their modules and assets are laid out under
   * `workers/<name>/`.
   */
  otherWorkers?: FixtureWorker[];
  /** Mutate the manifest object after it is built (before signing). */
  tweak?: (manifest: ArtifactManifest) => void;
  /**
   * A revision the catalog lists for the release: these fields over the
   * signed catalog manifest, `revision` 2 unless given. The index row points
   * at it and `serve` answers {@link REVISED_URL} with it.
   */
  revision?: Partial<CatalogManifest>;
}

/** One Worker of an app of several, other than the primary one. */
export interface FixtureWorker {
  name: string;
  bindings?: ArtifactManifest["worker"]["bindings"];
  crons?: string[];
  migrations?: ArtifactManifest["worker"]["migrations"];
  queueConsumers?: ArtifactManifest["worker"]["queueConsumers"];
  assets?: Array<{ route: string; content: string }>;
}

/** Where a fixture's revised catalog manifest is served. */
export const REVISED_URL = "https://catalog.test/apps/cut/manifest.json";

export interface ArtifactFixture {
  manifest: ArtifactManifest;
  manifestBytes: Uint8Array;
  signature: string;
  digest: string;
  keys: SigningKey[];
  zip: Uint8Array;
  /** An artifact tier entry: it always has its release artifacts. */
  index: IndexApp & Required<Pick<IndexApp, "artifacts" | "digest">>;
  /** The revised catalog manifest the index lists, and its exact bytes; null without one. */
  revised: { catalog: CatalogManifest; bytes: Uint8Array<ArrayBuffer> } | null;
  /** Signs any bytes with the fixture's key (base64), as catalog CI signs a revision. */
  signBytes(bytes: Uint8Array): Promise<string>;
  /** Serves the zip (Range), manifest, signature and revision; `null` for other URLs. */
  serve(url: string, init?: RequestInit): Response | null;
}

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function baseCatalog(overrides: Partial<CatalogManifest> = {}): CatalogManifest {
  return {
    slug: "cut",
    name: "Cut",
    summary: "Self-hosted link shortener on Workers + KV.",
    homepage: "https://github.com/MendyLanda/cut",
    repo: "MendyLanda/cut",
    license: "MIT",
    categories: ["utilities"],
    maintainers: ["MendyLanda"],
    source: { ref: "main", sha: "6056400d47530aa87e4ae5764b37ffca9d00e87f" },
    install: {
      tier: "artifact",
      packageManager: "pnpm",
      wranglerConfig: "wrangler.jsonc",
      workerName: "cut",
    },
    plan: "free",
    requires: [],
    secrets: [
      { name: "ADMIN_PASSWORD", label: "Admin password", help: "Sign in.", generate: true },
    ],
    vars: [{ name: "HOME_PAGE", label: "Home page", help: "default", required: false }],
    postInstall: [{ type: "markdown", content: "Open {{workerUrl}}/admin." }],
    tokenPermissions: [],
    ...overrides,
  };
}

export async function buildArtifactFixture(
  opts: ArtifactFixtureOptions = {},
): Promise<ArtifactFixture> {
  const version = opts.version ?? "1.0.0";
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const place = async (path: string, content: string) => {
    const bytes = enc.encode(content);
    const entry = { path, size: bytes.byteLength, offset, sha256: await sha256Hex(bytes) };
    chunks.push(enc.encode("HDR!"), bytes);
    // A fake 4-byte "local header" before each file keeps offsets non-trivial.
    entry.offset += 4;
    offset += 4 + bytes.byteLength;
    return entry;
  };

  const worker = await place(
    "worker/worker.js",
    "export default { fetch() { return new Response('ok') } };",
  );
  const extraModules = [];
  for (const [i, m] of (opts.extraModules ?? []).entries()) {
    const name = `chunk-${i + 1}.js`;
    extraModules.push({
      name,
      type: "esm" as const,
      ...(await place(`worker/${name}`, m.content)),
    });
  }
  const assets = [];
  for (const a of opts.assets ?? []) {
    const placed = await place(`assets${a.route}`, a.content);
    assets.push({ route: a.route, hash: assetHash(a.content, a.route), ...placed });
  }
  const others = [];
  for (const w of opts.otherWorkers ?? []) {
    const module = await place(
      `workers/${w.name}/worker/worker.js`,
      `export default { fetch() { return new Response('${w.name}') } };`,
    );
    const files = [];
    for (const a of w.assets ?? []) {
      const placed = await place(`workers/${w.name}/assets${a.route}`, a.content);
      files.push({ route: a.route, hash: assetHash(a.content, a.route), ...placed });
    }
    others.push({
      name: w.name,
      worker: {
        name: `cut-${w.name}`,
        mainModule: "worker.js",
        compatibilityDate: "2024-12-30",
        compatibilityFlags: ["nodejs_compat"],
        modules: [{ name: "worker.js", type: "esm" as const, ...module }],
        bindings: w.bindings ?? [],
        migrations: w.migrations ?? [],
        crons: w.crons ?? [],
        ...(w.queueConsumers === undefined ? {} : { queueConsumers: w.queueConsumers }),
        observability: null,
        placement: null,
        limits: null,
      },
      assets: { config: {}, binding: null, files },
    });
  }
  const d1: ArtifactManifest["d1Migrations"] = {};
  for (const [binding, files] of Object.entries(opts.d1 ?? {})) {
    d1[binding] = [];
    for (const f of files) {
      const placed = await place(`d1/${binding}/${f.name}`, f.content);
      d1[binding].push({ name: f.name, ...placed });
    }
  }
  const zip = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    zip.set(c, at);
    at += c.byteLength;
  }

  const catalog = baseCatalog(opts.catalog);
  if (others.length > 0) {
    catalog.install.workers = [
      { name: "app", wranglerConfig: catalog.install.wranglerConfig, primary: true },
      ...others.map((w) => ({ name: w.name, wranglerConfig: `${w.name}/wrangler.jsonc` })),
    ];
  }
  const fields = {
    app: "cut",
    version,
    source: {
      repo: "MendyLanda/cut",
      sha: "6056400d47530aa87e4ae5764b37ffca9d00e87f",
      ref: "main",
    },
    builtAt: "2026-09-22T18:54:30.094Z",
    builder: "@appflare/pack@0.0.0",
    keyId: opts.keyId ?? "test-key",
    worker: {
      name: "cut",
      mainModule: "worker.js",
      compatibilityDate: "2024-12-30",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ name: "worker.js", type: "esm" as const, ...worker }, ...extraModules],
      bindings: opts.bindings ?? [{ type: "kv_namespace", name: "CUT_KV" }],
      migrations: opts.migrations ?? [],
      crons: opts.crons ?? [],
      observability: null,
      placement: null,
      limits: null,
    },
    assets: { config: {}, binding: null, files: assets },
    d1Migrations: d1,
    catalog,
  };
  const manifest: ArtifactManifest =
    others.length > 0 ? { format: 2, ...fields, workers: others } : { format: 1, ...fields };
  opts.tweak?.(manifest);

  const manifestBytes = enc.encode(JSON.stringify(manifest, null, 2));
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const signature = toBase64(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, manifestBytes)),
  );
  const digest = await sha256Hex(manifestBytes);
  const index: ArtifactFixture["index"] = {
    slug: "cut",
    name: "Cut",
    summary: manifest.catalog.summary,
    version,
    artifacts: { zip: ZIP_URL, manifest: MANIFEST_URL, sig: SIG_URL },
    digest,
    tier: "artifact",
    plan: manifest.catalog.plan,
    requires: manifest.catalog.requires,
    lastVerified: null,
    maintainers: ["MendyLanda"],
  };
  const signBytes = async (bytes: Uint8Array): Promise<string> =>
    toBase64(
      new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new Uint8Array(bytes)),
      ),
    );
  let revised: ArtifactFixture["revised"] = null;
  if (opts.revision !== undefined) {
    const catalog: CatalogManifest = { ...manifest.catalog, revision: 2, ...opts.revision };
    const bytes = enc.encode(`${JSON.stringify(catalog, null, 2)}\n`);
    revised = { catalog, bytes };
    index.revision = catalog.revision ?? 1;
    // Signed like the release: same key, same key id.
    index.catalogManifest = {
      url: REVISED_URL,
      sha256: await sha256Hex(bytes),
      keyId: manifest.keyId,
      signature: await signBytes(bytes),
    };
  }

  return {
    manifest,
    manifestBytes,
    signature,
    digest,
    keys: [{ keyId: opts.keyId ?? "test-key", publicKeyBase64: toBase64(raw) }],
    zip,
    index,
    revised,
    signBytes,
    serve(url, init) {
      if (url === MANIFEST_URL) return new Response(manifestBytes);
      if (url === REVISED_URL && revised !== null) return new Response(revised.bytes);
      if (url === SIG_URL) return new Response(`${signature}\n`);
      if (url !== ZIP_URL) return null;
      const range = new Headers(init?.headers).get("range");
      const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
      if (m === null) return new Response(zip);
      const start = Number(m[1]);
      const end = Number(m[2]);
      return new Response(zip.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${zip.byteLength}` },
      });
    },
  };
}
