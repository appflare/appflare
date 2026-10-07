import { assetHash } from "@appflare/cf-api";
import { type ArtifactManifest, artifactManifestSchema, type SigningKey } from "@appflare/schema";

/**
 * Test-only signed Appflare release: a byte blob standing in for the stored
 * (uncompressed) zip, with every file at a recorded offset, a manifest shaped
 * like a real manager release, and a signature from a key made for the test.
 * The embedded production keys are never used.
 */

export interface ReleaseFixture {
  version: string;
  manifest: ArtifactManifest;
  manifestBytes: Uint8Array;
  signature: string;
  zip: Uint8Array;
  keys: SigningKey[];
  /** The module's bytes, for checking what was uploaded. */
  moduleText: string;
  assetContents: Map<string, string>;
}

export interface ReleaseOptions {
  version?: string;
  keyId?: string;
  assetCount?: number;
  /** Changes the manifest before it is signed. */
  tweak?: (manifest: ArtifactManifest) => void;
}

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signingKeyPair(keyId: string): Promise<{
  key: SigningKey;
  sign: (bytes: Uint8Array) => Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    key: { keyId, publicKeyBase64: b64(raw) },
    sign: async (bytes) =>
      b64(
        new Uint8Array(
          await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new Uint8Array(bytes)),
        ),
      ),
  };
}

export async function buildRelease(opts: ReleaseOptions = {}): Promise<ReleaseFixture> {
  const version = opts.version ?? "0.4.0";
  const keyId = opts.keyId ?? "appflare-test";
  const parts: Uint8Array[] = [enc.encode("PK\u0003\u0004 header")];
  let offset = parts[0]?.byteLength ?? 0;
  const place = async (path: string, content: string) => {
    const header = enc.encode(`[${path}]`);
    parts.push(header);
    offset += header.byteLength;
    const bytes = enc.encode(content);
    const at = offset;
    parts.push(bytes);
    offset += bytes.byteLength;
    return { path, offset: at, size: bytes.byteLength, sha256: await sha256(bytes) };
  };

  const moduleText = `export default { fetch() { return new Response("appflare ${version}"); } };`;
  const module = {
    name: "index.js",
    type: "esm" as const,
    ...(await place("worker/index.js", moduleText)),
  };
  const assetContents = new Map<string, string>();
  const assets = [];
  const count = opts.assetCount ?? 3;
  for (let i = 0; i < count; i++) {
    const route = i === 0 ? "/index.html" : `/assets/chunk-${i}.js`;
    const content = i === 0 ? "<!doctype html><title>Appflare</title>" : `console.log(${i});`;
    assetContents.set(route, content);
    assets.push({
      route,
      hash: assetHash(content, route),
      ...(await place(`assets${route}`, content)),
    });
  }
  const migration = await place("d1/DB/0000_init.sql", "CREATE TABLE settings (key TEXT);");

  const manifest = artifactManifestSchema.parse({
    format: 1,
    app: "appflare",
    version,
    builtAt: "2026-10-01T10:00:00Z",
    builder: "@appflare/pack@0.3.0",
    keyId,
    worker: {
      name: "appflare",
      wranglerConfig: {
        declared: "dist/server/wrangler.release.json",
        effective: "dist/server/wrangler.release.json",
      },
      mainModule: "index.js",
      compatibilityDate: "2026-09-21",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      modules: [module],
      bindings: [
        { type: "kv_namespace", name: "KV" },
        { type: "d1", name: "DB" },
        {
          type: "workflow",
          name: "JOBS",
          workflow_name: "appflare-jobs",
          class_name: "JobWorkflow",
        },
        { type: "version_metadata", name: "CF_VERSION_METADATA" },
        { type: "plain_text", name: "APPFLARE_VERSION", text: version },
      ],
      migrations: [],
      crons: ["*/30 * * * *"],
      queueConsumers: [],
      observability: { enabled: true },
      placement: null,
      limits: null,
    },
    assets: {
      config: {
        not_found_handling: "single-page-application",
        run_worker_first: ["/*", "!/assets/*"],
      },
      binding: "ASSETS",
      files: assets,
    },
    d1: {
      DB: { migrations: [{ name: "0000_init.sql", ...migration }], schema: [], postDeploy: [] },
    },
    catalog: {
      slug: "appflare",
      name: "Appflare",
      summary: "A single Worker in your own Cloudflare account that installs and updates apps.",
      tagline: "Install and update apps in your own Cloudflare account",
      repo: "appflare/appflare",
      license: "Apache-2.0",
      categories: ["utilities"],
      maintainers: ["MendyLanda"],
      source: { ref: version, sha: "5e1f4f360d3f12adcef66adac922a4a69be9af84" },
      install: {
        tier: "artifact",
        packageManager: "pnpm",
        wranglerConfig: "dist/server/wrangler.release.json",
        fixedWorkerName: false,
        health: { path: "/", mode: "no-server-errors" },
      },
      plan: "free",
      requires: [],
      secrets: [],
      vars: [],
      postInstall: [],
      tokenPermissions: [],
      bump: { autoMerge: false },
      revision: 1,
    },
  });
  opts.tweak?.(manifest);
  const manifestBytes = enc.encode(JSON.stringify(manifest, null, 2));
  parts.push(manifestBytes);
  const zip = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    zip.set(part, at);
    at += part.byteLength;
  }
  const { key, sign } = await signingKeyPair(keyId);
  return {
    version,
    manifest,
    manifestBytes,
    signature: await sign(manifestBytes),
    zip,
    keys: [key],
    moduleText,
    assetContents,
  };
}
