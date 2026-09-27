import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  type SigningKey,
  signingKeys,
  verifyManifestSignature,
} from "@appflare/schema";

/** `manifest.app` of every manager artifact. */
export const MANAGER_APP = "appflare";

/** What each artifact is called in messages. */
const APP_LABELS: Record<string, string> = {
  [MANAGER_APP]: "the Appflare manager",
};

/** A verified artifact. */
export interface VerifiedArtifact {
  manifest: ArtifactManifest;
  zipPath: string;
  /** The key that signed it, or null when it had no signature (`--allow-unsigned`). */
  keyId: string | null;
}

/** Options for {@link verifyArtifact}. */
export interface VerifyArtifactOptions {
  /** Directory holding `manifest.json`, `manifest.sig`, and `appflare-<version>.zip`. */
  dir: string;
  /**
   * Accept a missing manifest.sig (a present one is still verified).
   * Development only: the CLI allows it only with `APPFLARE_DEV=1` and
   * `--artifact-dir`.
   */
  allowUnsigned?: boolean;
  /** Trusted keys; `signingKeys` from @appflare/schema unless a test injects its own. */
  keys?: readonly SigningKey[];
  /** When set (a downloaded release), `manifest.version` must equal it. */
  expectedVersion?: string;
  /** The `manifest.app` required: the manager's by default. */
  app?: string;
}

/** The zip file name of an artifact version: `<app>-<version>.zip` (the manager's by default). */
export function artifactZipName(version: string, app: string = MANAGER_APP): string {
  return `${app}-${version}.zip`;
}

/**
 * Checks the Ed25519 signature over the exact
 * `manifest.json` bytes (key picked by `keyId`, unknown ids and "unsigned"
 * rejected), validates the manifest, requires the expected `app`, and checks the
 * zip is where the manifest says. File hashes are checked while unpacking
 * ({@link unpackArtifact}), before anything is written.
 */
export async function verifyArtifact(options: VerifyArtifactOptions): Promise<VerifiedArtifact> {
  const dir = path.resolve(options.dir);
  const manifestPath = path.join(dir, "manifest.json");
  const signaturePath = path.join(dir, "manifest.sig");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${dir}`);
  }
  const manifestBytes = await readFile(manifestPath);

  let keyId: string | null = null;
  // A signature that is present is always checked; --allow-unsigned only
  // tolerates its absence.
  if (!existsSync(signaturePath)) {
    if (!options.allowUnsigned) {
      throw new Error(`manifest.sig not found in ${dir}; the artifact is not signed`);
    }
  } else {
    const signature = await readFile(signaturePath, "utf8");
    ({ keyId } = await verifyManifestSignature(
      manifestBytes,
      signature.trim(),
      options.keys ?? signingKeys,
    ));
  }

  let json: unknown;
  try {
    json = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  const parsed = artifactManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`manifest.json is not a valid artifact manifest: ${parsed.error.message}`);
  }
  const manifest = parsed.data;
  const app = options.app ?? MANAGER_APP;
  if (manifest.app !== app) {
    throw new Error(`this artifact is "${manifest.app}", not ${APP_LABELS[app] ?? `"${app}"`}`);
  }
  if (options.expectedVersion !== undefined && manifest.version !== options.expectedVersion) {
    throw new Error(
      `the release is ${options.expectedVersion} but its manifest says ${manifest.version}`,
    );
  }
  const zipName = artifactZipName(manifest.version, app);
  const zipPath = path.join(dir, zipName);
  if (!existsSync(zipPath)) {
    throw new Error(`${zipName} not found in ${dir}`);
  }
  return { manifest, zipPath, keyId };
}

/** Where {@link unpackArtifact} put things, relative to its output directory. */
export interface UnpackedArtifact {
  /** Directory of the Worker modules (`worker`). */
  workerDir: string;
  /** Directory of the static assets (`assets`). */
  assetsDir: string;
  moduleCount: number;
  assetCount: number;
}

export const UNPACKED_WORKER_DIR = "worker";
export const UNPACKED_ASSETS_DIR = "assets";

/**
 * Resolves `relative` (slash-separated, from the manifest) under `root`,
 * rejecting absolute paths, empty segments, `.` and `..`, and backslashes, so a
 * manifest can never write outside the directory.
 */
export function safeJoin(root: string, relative: string): string {
  const segments = relative.split("/");
  if (
    relative.length === 0 ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`unsafe path in the artifact manifest: ${JSON.stringify(relative)}`);
  }
  return path.join(root, ...segments);
}

/**
 * Reads every file the manifest lists (Worker modules, assets, and D1
 * migrations) as the exact byte slice `[offset, offset + size)` of the STORE
 * zip, checks its size and sha256 (like `appflare-pack verify`), and writes
 * the modules to `<outDir>/worker/<name>` and the assets to
 * `<outDir>/assets/<route>`. D1 migrations are only checked: the manager applies
 * its own migrations at boot. Every file is checked before the
 * first one is written.
 */
export async function unpackArtifact(
  manifest: ArtifactManifest,
  zipPath: string,
  outDir: string,
): Promise<UnpackedArtifact> {
  const workerDir = path.join(outDir, UNPACKED_WORKER_DIR);
  const assetsDir = path.join(outDir, UNPACKED_ASSETS_DIR);
  if (manifest.worker.mainModule === undefined) {
    throw new Error("the release has no Worker code (it serves static assets only)");
  }
  if (!manifest.worker.modules.some((m) => m.name === manifest.worker.mainModule)) {
    throw new Error(
      `the main module ${manifest.worker.mainModule} is not among the Worker modules`,
    );
  }

  const writes: { target: string; data: Buffer }[] = [];
  const zipSize = (await stat(zipPath)).size;
  const zip = await open(zipPath, "r");
  try {
    const read = async (entry: { path: string; size: number; offset: number; sha256: string }) => {
      if (entry.offset + entry.size > zipSize) {
        throw new Error(
          `${entry.path} lies outside the zip (offset ${entry.offset}, size ${entry.size})`,
        );
      }
      const data = Buffer.alloc(entry.size);
      const { bytesRead } =
        entry.size === 0 ? { bytesRead: 0 } : await zip.read(data, 0, entry.size, entry.offset);
      if (bytesRead !== entry.size) {
        throw new Error(
          `short read for ${entry.path}: expected ${entry.size} bytes, got ${bytesRead}`,
        );
      }
      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== entry.sha256) {
        throw new Error(`sha256 mismatch for ${entry.path}: the zip does not match the manifest`);
      }
      return data;
    };

    for (const module of manifest.worker.modules) {
      writes.push({ target: safeJoin(workerDir, module.name), data: await read(module) });
    }
    for (const asset of manifest.assets.files) {
      if (!asset.route.startsWith("/")) {
        throw new Error(`asset route ${JSON.stringify(asset.route)} does not start with /`);
      }
      writes.push({ target: safeJoin(assetsDir, asset.route.slice(1)), data: await read(asset) });
    }
    for (const migration of Object.values(manifest.d1Migrations).flat()) {
      await read(migration);
    }
  } finally {
    await zip.close();
  }
  // The packer records these files' text in the assets config; wrangler reads
  // them from the root of the assets directory.
  for (const name of ["_redirects", "_headers"] as const) {
    const text = manifest.assets.config[name];
    if (text !== undefined)
      writes.push({ target: path.join(assetsDir, name), data: Buffer.from(text) });
  }

  await mkdir(workerDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  for (const { target, data } of writes) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  return {
    workerDir,
    assetsDir,
    moduleCount: manifest.worker.modules.length,
    assetCount: manifest.assets.files.length,
  };
}
