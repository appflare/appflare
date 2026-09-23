/**
 * Test-only helpers: a small manager-shaped artifact built in-process with
 * @appflare/pack's ZipStore and signed with a throwaway Ed25519 key, so tests
 * never need the network, a real release, or the real signing key.
 */
import { createHash, webcrypto } from "node:crypto";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZipStore } from "@appflare/pack";
import type { ArtifactManifest, SigningKey } from "@appflare/schema";

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

export interface TestKey {
  key: SigningKey;
  privateKey: CryptoKey;
}

export async function makeTestKey(keyId = "test-2026-09"): Promise<TestKey> {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  return { key: { keyId, publicKeyBase64: raw.toString("base64") }, privateKey: pair.privateKey };
}

export async function signBytes(bytes: Uint8Array, privateKey: CryptoKey): Promise<string> {
  const sig = await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, new Uint8Array(bytes));
  return Buffer.from(sig).toString("base64");
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export interface FixtureOptions {
  version?: string;
  keyId?: string;
  /** Sign with this key (writes manifest.sig); unsigned when omitted. */
  sign?: TestKey;
  /** Edit the manifest before it is serialized (and signed). */
  mutate?: (manifest: ArtifactManifest) => void;
  /** Replace a file's bytes in the zip after hashing (tamper test). */
  tamper?: string;
}

export interface Fixture {
  dir: string;
  manifest: ArtifactManifest;
  manifestBytes: Buffer;
}

const FILES = {
  "worker/index.js":
    'import "./chunks/a.js";\nexport default { fetch() { return new Response("ok"); } };\n',
  "worker/chunks/a.js": "export const a = 1;\n",
  "assets/index.html": "<!doctype html><title>Appflare</title>\n",
  "assets/assets/app.js": "console.log('app');\n",
  "d1/DB/0000_init.sql": "CREATE TABLE settings (key TEXT PRIMARY KEY);\n",
};

/** Writes `<app>-<version>.zip`, `manifest.json`, and optionally `manifest.sig` to a temp dir. */
export async function buildFixtureArtifact(options: FixtureOptions = {}): Promise<Fixture> {
  const version = options.version ?? "0.1.0";
  const dir = mkdtempSync(path.join(tmpdir(), "appflare-cli-fixture-"));
  const zip = new ZipStore();
  const placed = new Map<string, { offset: number; size: number; sha256: string }>();
  for (const [name, text] of Object.entries(FILES)) {
    const data = Buffer.from(text);
    const hashed = sha256(data);
    const stored = options.tamper === name ? Buffer.from(text.replace(/./, "X")) : data;
    const { dataOffset } = zip.addFile(name, stored);
    placed.set(name, { offset: dataOffset, size: data.length, sha256: hashed });
  }
  const at = (p: string) => ({
    path: p,
    ...(placed.get(p) as { offset: number; size: number; sha256: string }),
  });
  const manifest: ArtifactManifest = {
    format: 1,
    app: "appflare",
    version,
    source: { repo: "appflare/appflare", sha: "a".repeat(40), ref: version },
    builtAt: "2026-09-22T12:00:00.000Z",
    builder: "@appflare/pack@0.0.0",
    keyId: options.keyId ?? options.sign?.key.keyId ?? "unsigned",
    worker: {
      name: "appflare",
      mainModule: "index.js",
      compatibilityDate: "2026-09-21",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      modules: [
        { name: "index.js", type: "esm", ...at("worker/index.js") },
        { name: "chunks/a.js", type: "esm", ...at("worker/chunks/a.js") },
      ],
      bindings: [
        { type: "kv_namespace", name: "KV" },
        { type: "d1", name: "DB" },
        {
          type: "workflow",
          name: "JOBS",
          workflow_name: "appflare-jobs",
          class_name: "JobWorkflow",
        },
        { type: "plain_text", name: "APPFLARE_VERSION", text: version },
      ],
      migrations: [],
      crons: ["*/30 * * * *"],
      observability: { enabled: true },
      placement: null,
      limits: null,
    },
    assets: {
      config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
      binding: "ASSETS",
      files: [
        { route: "/index.html", hash: "0".repeat(32), ...at("assets/index.html") },
        { route: "/assets/app.js", hash: "1".repeat(32), ...at("assets/assets/app.js") },
      ],
    },
    d1Migrations: { DB: [{ name: "0000_init.sql", ...at("d1/DB/0000_init.sql") }] },
    catalog: {
      slug: "appflare",
      name: "Appflare",
      summary: "The manager.",
      homepage: "https://github.com/appflare/appflare",
      repo: "appflare/appflare",
      license: "Apache-2.0",
      categories: ["platform"],
      maintainers: ["MendyLanda"],
      source: { ref: version, sha: "a".repeat(40) },
      install: {
        tier: "artifact",
        packageManager: "pnpm",
        wranglerConfig: "dist/server/wrangler.json",
        workerName: "appflare",
      },
      plan: "free",
      requires: [],
      secrets: [],
      vars: [],
      postInstall: [],
      tokenPermissions: [],
    },
  };
  options.mutate?.(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  zip.addFile("manifest.json", manifestBytes);
  writeFileSync(path.join(dir, `${manifest.app}-${manifest.version}.zip`), zip.finish());
  writeFileSync(path.join(dir, "manifest.json"), manifestBytes);
  if (options.sign) {
    writeFileSync(
      path.join(dir, "manifest.sig"),
      `${await signBytes(manifestBytes, options.sign.privateKey)}\n`,
    );
  }
  return { dir, manifest, manifestBytes };
}

/** A scripted wrangler for command tests: answers by the command words, records every call. */
export interface FakeCall {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: import("./wrangler.ts").StdinMode;
  output: import("./wrangler.ts").OutputMode;
}

export type FakeHandler = (
  call: FakeCall,
) =>
  | Partial<import("./wrangler.ts").SpawnResult>
  | Promise<Partial<import("./wrangler.ts").SpawnResult>>;

/**
 * `handlers` is keyed by the first one or two command words (`"whoami"`,
 * `"secret put"`, `"deployments list"`); unknown commands fail the test.
 */
export function fakeSpawner(handlers: Record<string, FakeHandler>): {
  spawner: import("./wrangler.ts").Spawner;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const spawner: import("./wrangler.ts").Spawner = async (request) => {
    const [bin, ...args] = request.args;
    if (bin !== "/fake/wrangler.js" || request.command !== process.execPath) {
      throw new Error(`unexpected spawn ${request.command} ${request.args.join(" ")}`);
    }
    const call: FakeCall = {
      args,
      cwd: request.cwd,
      env: request.env,
      stdin: request.stdin,
      output: request.output,
    };
    calls.push(call);
    const two = args.slice(0, 2).join(" ");
    const one = args[0] ?? "";
    const handler = handlers[two] ?? handlers[one];
    if (!handler) {
      throw new Error(`no fake for wrangler ${args.join(" ")}`);
    }
    const result = await handler(call);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { spawner, calls };
}

/** A UI that records output and answers prompts from a queue. */
export function fakeUi(options: { interactive?: boolean; answers?: (string | boolean)[] } = {}) {
  const lines: string[] = [];
  const results: string[] = [];
  const answers = [...(options.answers ?? [])];
  const ui: import("./ui.ts").Ui = {
    interactive: options.interactive ?? false,
    banner: () => lines.push("Appflare"),
    step: (m) => lines.push(`> ${m}`),
    info: (m) => lines.push(`  ${m}`),
    warn: (m) => lines.push(`! ${m}`),
    result: (m) => results.push(m),
    confirm: async () => answers.shift() as boolean,
    text: async () => answers.shift() as string,
    select: async <T extends string>() => answers.shift() as T,
  };
  return { ui, lines, results };
}

export const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authType: "OAuth Token",
  email: "me@example.com",
  accounts: [{ id: "acc-1", name: "Acme" }],
});
