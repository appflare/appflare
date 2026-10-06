import { assetHash } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type CatalogManifest,
  type CatalogSecret,
  type CatalogVar,
  catalogManifestSchema,
  catalogSecretSchema,
  catalogVarSchema,
  type IndexApp,
  LATEST_ARTIFACT_FORMAT,
  type SigningKey,
} from "@appflare/schema";
import type { z } from "zod";
import { sha256Hex } from "../jobs/install/artifact";

/**
 * A catalog manifest as written: what `baseCatalog` and the fixture take,
 * with the schema's defaults (tier, health, flags, empty lists) filled in
 * when they parse it.
 */
export type CatalogInput = z.input<typeof catalogManifestSchema>;

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
  catalog?: Partial<CatalogInput>;
  bindings?: ArtifactManifest["worker"]["bindings"];
  assets?: Array<{ route: string; content: string }>;
  d1?: Record<string, Array<{ name: string; content: string }>>;
  /**
   * Schema files by binding, in the order they run; the catalog manifest
   * declares them in `resources.d1` (unless `catalog.resources` is given).
   */
  d1Schema?: Record<string, Array<{ name: string; content: string }>>;
  /** Post-deploy migrations by binding, declared in `resources.d1` the same way. */
  d1PostDeploy?: Record<string, Array<{ name: string; content: string }>>;
  /** A baseline by binding, declared in `resources.d1` the same way. */
  d1Baseline?: Record<string, { name: string; content: string }>;
  crons?: string[];
  migrations?: ArtifactManifest["worker"]["migrations"];
  /** The primary Worker's `exports` and `cacheOptions`. */
  exports?: ArtifactManifest["worker"]["exports"];
  cacheOptions?: ArtifactManifest["worker"]["cacheOptions"];
  /**
   * More modules for the Worker, laid out right after `worker.js` as the
   * packer writes a Worker's modules; each is `chunk-<n>.js`.
   */
  extraModules?: Array<{ content: string }>;
  /**
   * A Worker of static assets only: no modules and no
   * `mainModule`, no bindings, and a catalog manifest without secrets or vars
   * unless `bindings` or `catalog` say otherwise. Give it `assets`.
   */
  assetsOnly?: boolean;
  /**
   * Makes the app one of several Workers: the fixture's Worker is
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
  revision?: Partial<CatalogInput>;
}

/** One Worker of an app of several, other than the primary one. */
export interface FixtureWorker {
  name: string;
  bindings?: ArtifactManifest["worker"]["bindings"];
  crons?: string[];
  migrations?: ArtifactManifest["worker"]["migrations"];
  queueConsumers?: ArtifactManifest["worker"]["queueConsumers"];
  exports?: ArtifactManifest["worker"]["exports"];
  assets?: Array<{ route: string; content: string }>;
  /** `install.workers[].workersDev`; false keeps it off workers.dev. */
  workersDev?: boolean;
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
  index: IndexApp & Required<Pick<IndexApp, "artifacts">>;
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

/** The fixture's catalog manifest as written, `overrides` over it. */
export function baseCatalogInput(overrides: Partial<CatalogInput> = {}): CatalogInput {
  return {
    slug: "cut",
    name: "Cut",
    summary: "Self-hosted link shortener on Workers + KV.",
    tagline: "Short links on your own domain",
    homepage: "https://github.com/MendyLanda/cut",
    repo: "MendyLanda/cut",
    license: "MIT",
    categories: ["utilities"],
    maintainers: ["MendyLanda"],
    source: { ref: "main", sha: "6056400d47530aa87e4ae5764b37ffca9d00e87f" },
    install: {
      packageManager: "pnpm",
      wranglerConfig: "wrangler.jsonc",
    },
    plan: "free",
    secrets: [
      { name: "ADMIN_PASSWORD", label: "Admin password", help: "Sign in.", generate: "password" },
    ],
    vars: [{ name: "HOME_PAGE", label: "Home page", help: "default", optional: true }],
    postInstall: [{ type: "markdown", content: "Open {{appUrl}}/admin." }],
    ...overrides,
  };
}

/** Catalog secrets as written, as the schema reads them (flags default to false). */
export function secretsOf(
  secrets: ReadonlyArray<z.input<typeof catalogSecretSchema>>,
): CatalogSecret[] {
  return secrets.map((s) => catalogSecretSchema.parse(s));
}

/** Catalog vars as written, as the schema reads them (`type` "text", flags false). */
export function varsOf(vars: ReadonlyArray<z.input<typeof catalogVarSchema>>): CatalogVar[] {
  return vars.map((v) => catalogVarSchema.parse(v));
}

/** The fixture's catalog manifest, `overrides` over it, as the schema reads it (defaults filled in). */
export function baseCatalog(overrides: Partial<CatalogInput> = {}): CatalogManifest {
  return catalogManifestSchema.parse(baseCatalogInput(overrides));
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

  const assetsOnly = opts.assetsOnly === true;
  const worker = assetsOnly
    ? null
    : await place("worker/worker.js", "export default { fetch() { return new Response('ok') } };");
  const extraModules = [];
  for (const [i, m] of (assetsOnly ? [] : (opts.extraModules ?? [])).entries()) {
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
        wranglerConfig: { declared: `${w.name}/wrangler.jsonc`, effective: "{}" },
        mainModule: "worker.js",
        compatibilityDate: "2024-12-30",
        compatibilityFlags: ["nodejs_compat"],
        modules: [{ name: "worker.js", type: "esm" as const, ...module }],
        bindings: w.bindings ?? [],
        migrations: w.migrations ?? [],
        crons: w.crons ?? [],
        queueConsumers: w.queueConsumers ?? [],
        ...(w.exports === undefined ? {} : { exports: w.exports }),
        observability: null,
        placement: null,
        limits: null,
      },
      assets: { config: {}, binding: null, files },
    });
  }
  type D1Files = ArtifactManifest["d1"][string]["migrations"];
  const placeD1 = async (dir: string, byBinding: ArtifactFixtureOptions["d1"]) => {
    const placed: Record<string, D1Files> = {};
    for (const [binding, files] of Object.entries(byBinding ?? {})) {
      placed[binding] = [];
      for (const f of files) {
        placed[binding].push({
          name: f.name,
          ...(await place(`${dir}/${binding}/${f.name}`, f.content)),
        });
      }
    }
    return placed;
  };
  const d1Migrations = await placeD1("d1", opts.d1);
  const d1Schema = await placeD1("d1-schema", opts.d1Schema);
  const d1PostDeploy = await placeD1("d1-post-deploy", opts.d1PostDeploy);
  const d1Baseline = await placeD1(
    "d1-baseline",
    opts.d1Baseline === undefined
      ? undefined
      : Object.fromEntries(Object.entries(opts.d1Baseline).map(([b, f]) => [b, [f]])),
  );
  const zip = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    zip.set(c, at);
    at += c.byteLength;
  }

  // One entry per binding with any SQL, as the packer groups it.
  const d1: ArtifactManifest["d1"] = {};
  for (const binding of new Set([
    ...Object.keys(d1Migrations),
    ...Object.keys(d1Schema),
    ...Object.keys(d1PostDeploy),
    ...Object.keys(d1Baseline),
  ])) {
    const baseline = Object.hasOwn(d1Baseline, binding) ? d1Baseline[binding]?.[0] : undefined;
    d1[binding] = {
      migrations: Object.hasOwn(d1Migrations, binding) ? (d1Migrations[binding] ?? []) : [],
      schema: Object.hasOwn(d1Schema, binding) ? (d1Schema[binding] ?? []) : [],
      postDeploy: Object.hasOwn(d1PostDeploy, binding) ? (d1PostDeploy[binding] ?? []) : [],
      ...(baseline === undefined ? {} : { baseline }),
    };
  }

  const catalogInput = baseCatalogInput(
    assetsOnly ? { secrets: [], vars: [], ...opts.catalog } : opts.catalog,
  );
  if (
    opts.catalog?.resources === undefined &&
    (opts.d1Schema ?? opts.d1PostDeploy ?? opts.d1Baseline) !== undefined
  ) {
    const d1: NonNullable<CatalogInput["resources"]>["d1"] = {};
    const bindings = [
      ...Object.keys(d1Schema),
      ...Object.keys(d1PostDeploy),
      ...Object.keys(d1Baseline),
    ];
    for (const binding of new Set(bindings)) {
      d1[binding] = {
        ...(Object.hasOwn(d1Baseline, binding)
          ? { baseline: d1Baseline[binding]?.[0]?.name ?? "" }
          : {}),
        ...(Object.hasOwn(d1Schema, binding)
          ? { schema: (d1Schema[binding] ?? []).map((f) => f.name) }
          : {}),
        ...(Object.hasOwn(d1PostDeploy, binding)
          ? { postDeployMigrationsDir: "after-deploy" }
          : {}),
      };
    }
    catalogInput.resources = { d1 };
  }
  if (others.length > 0) {
    catalogInput.install = {
      ...catalogInput.install,
      workers: [
        { name: "app", wranglerConfig: catalogInput.install.wranglerConfig, primary: true },
        ...(opts.otherWorkers ?? []).map((w) => ({
          name: w.name,
          wranglerConfig: `${w.name}/wrangler.jsonc`,
          ...(w.workersDev === undefined ? {} : { workersDev: w.workersDev }),
        })),
      ],
    };
  }
  const catalog = catalogManifestSchema.parse(catalogInput);
  const fields = {
    app: "cut",
    version,
    builtAt: "2026-09-22T18:54:30.094Z",
    builder: "@appflare/pack@0.0.0",
    keyId: opts.keyId ?? "test-key",
    worker: {
      name: "cut",
      wranglerConfig: { declared: "wrangler.jsonc", effective: "{}" },
      ...(worker === null ? {} : { mainModule: "worker.js" }),
      compatibilityDate: "2024-12-30",
      compatibilityFlags: ["nodejs_compat"],
      modules:
        worker === null
          ? []
          : [{ name: "worker.js", type: "esm" as const, ...worker }, ...extraModules],
      bindings:
        opts.bindings ?? (assetsOnly ? [] : [{ type: "kv_namespace" as const, name: "CUT_KV" }]),
      migrations: opts.migrations ?? [],
      crons: opts.crons ?? [],
      queueConsumers: [],
      observability: null,
      placement: null,
      limits: null,
      ...(opts.exports === undefined ? {} : { exports: opts.exports }),
      ...(opts.cacheOptions === undefined ? {} : { cacheOptions: opts.cacheOptions }),
    },
    assets: { config: {}, binding: null, files: assets },
    d1,
    catalog,
  };
  const withWorkers = others.length > 0 ? { ...fields, workers: others } : fields;
  const manifest = { format: LATEST_ARTIFACT_FORMAT, ...withWorkers } as ArtifactManifest;
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
    tagline: manifest.catalog.tagline,
    addedAt: "2026-09-01T00:00:00Z",
    version,
    revision: manifest.catalog.revision,
    artifacts: { zip: ZIP_URL, manifest: MANIFEST_URL, sig: SIG_URL, digest },
    tier: "artifact",
    plan: manifest.catalog.plan,
    requires: manifest.catalog.requires,
    services: ["kv"],
    categories: manifest.catalog.categories,
    license: manifest.catalog.license,
    authors: [{ github: "MendyLanda", name: "MendyLanda" }],
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
    const catalog = catalogManifestSchema.parse({
      ...manifest.catalog,
      revision: 2,
      ...opts.revision,
    });
    const bytes = enc.encode(`${JSON.stringify(catalog, null, 2)}\n`);
    revised = { catalog, bytes };
    index.revision = catalog.revision;
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
