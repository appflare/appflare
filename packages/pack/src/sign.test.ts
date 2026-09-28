import { webcrypto } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pack } from "./pack.ts";
import { sign } from "./sign.ts";
import { verify } from "./verify.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.resolve(HERE, "..", "fixtures", "hello");
const FIXTURE_MANIFEST = path.join(FIXTURE, "appflare.jsonc");
const KEY_ENV = "APPFLARE_SIGN_TEST_KEY";

const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
/** A private copy of a packed artifact so each test starts from a clean state. */
function copyOf(artifactDir: string): string {
  const dir = tempDir("appflare-sign-copy-");
  cpSync(artifactDir, dir, { recursive: true });
  return dir;
}

async function generateKeypair(): Promise<{ privateBase64: string; publicBase64: string }> {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) {
    throw new Error("expected an Ed25519 key pair");
  }
  return {
    privateBase64: Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    ),
    publicBase64: Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString(
      "base64",
    ),
  };
}

describe("two-step pack then sign", () => {
  let intermediate: string; // packed with --key-id only
  let unsignedArtifact: string; // packed with neither flag
  let keys: { privateBase64: string; publicBase64: string };
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    keys = await generateKeypair();
    env = { ...process.env, [KEY_ENV]: keys.privateBase64 };
    intermediate = tempDir("appflare-sign-int-");
    const res = await pack({
      checkoutDir: FIXTURE,
      manifestPath: FIXTURE_MANIFEST,
      outDir: intermediate,
      install: false,
      keyId: "ci-key",
    });
    expect(res.signaturePath).toBeNull();
    unsignedArtifact = tempDir("appflare-sign-uns-");
    await pack({
      checkoutDir: FIXTURE,
      manifestPath: FIXTURE_MANIFEST,
      outDir: unsignedArtifact,
      install: false,
    });
  }, 120_000);

  afterAll(() => {
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pack with --key-id only records the id and writes no signature", async () => {
    const manifest = JSON.parse(readFileSync(path.join(intermediate, "manifest.json"), "utf8"));
    expect(manifest.keyId).toBe("ci-key");
    expect(existsSync(path.join(intermediate, "manifest.sig"))).toBe(false);

    const res = await verify({ dir: intermediate, hashesOnly: true });
    expect(res.signed).toBe(false);
    expect(res.checkedFiles).toBe(6);

    await expect(verify({ dir: intermediate })).rejects.toThrow(/manifest\.sig not found/);
    await expect(verify({ dir: intermediate, requireSigned: true })).rejects.toThrow(
      /manifest\.sig not found/,
    );
  });

  it("--hashes-only is exclusive with --require-signed and --public-key", async () => {
    await expect(
      verify({ dir: intermediate, hashesOnly: true, requireSigned: true }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      verify({ dir: intermediate, hashesOnly: true, publicKey: keys.publicBase64 }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("sign then verify --require-signed --public-key passes, without touching manifest or zip", async () => {
    const dir = copyOf(intermediate);
    const manifestBefore = readFileSync(path.join(dir, "manifest.json"));
    const zipBefore = readFileSync(path.join(dir, "hello-1.2.3.zip"));

    const res = await sign({ dir, signKeyEnv: KEY_ENV, keyId: "ci-key", env });
    expect(res.keyId).toBe("ci-key");
    expect(res.publicKey).toBe(keys.publicBase64); // derived from the private key
    expect(res.checkedFiles).toBe(6);

    expect(readFileSync(path.join(dir, "manifest.json")).equals(manifestBefore)).toBe(true);
    expect(readFileSync(path.join(dir, "hello-1.2.3.zip")).equals(zipBefore)).toBe(true);

    const verified = await verify({ dir, publicKey: keys.publicBase64, requireSigned: true });
    expect(verified.signed).toBe(true);
  });

  it('refuses keyId "unsigned"', async () => {
    const dir = copyOf(unsignedArtifact);
    await expect(sign({ dir, signKeyEnv: KEY_ENV, env })).rejects.toThrow(/"unsigned"/);
    expect(existsSync(path.join(dir, "manifest.sig"))).toBe(false);
  });

  it("refuses a --key-id that does not match manifest.keyId", async () => {
    const dir = copyOf(intermediate);
    await expect(sign({ dir, signKeyEnv: KEY_ENV, keyId: "other-key", env })).rejects.toThrow(
      /does not match manifest\.keyId "ci-key"/,
    );
    expect(existsSync(path.join(dir, "manifest.sig"))).toBe(false);
  });

  it("refuses to overwrite manifest.sig without --force", async () => {
    const dir = copyOf(intermediate);
    await sign({ dir, signKeyEnv: KEY_ENV, env });
    await expect(sign({ dir, signKeyEnv: KEY_ENV, env })).rejects.toThrow(/already exists/);
    const again = await sign({ dir, signKeyEnv: KEY_ENV, env, force: true });
    expect(again.checkedFiles).toBe(6);
  });

  it("fails without writing anything when the key env var is empty", async () => {
    const dir = copyOf(intermediate);
    await expect(
      sign({ dir, signKeyEnv: KEY_ENV, env: { ...process.env, [KEY_ENV]: "" } }),
    ).rejects.toThrow(/is not set/);
    expect(existsSync(path.join(dir, "manifest.sig"))).toBe(false);
  });

  it("detects a tampered manifest.json byte after signing", async () => {
    const dir = copyOf(intermediate);
    await sign({ dir, signKeyEnv: KEY_ENV, env });
    const manifestPath = path.join(dir, "manifest.json");
    // Flip the last digit of builtAt's fraction: still valid JSON and schema.
    const text = readFileSync(manifestPath, "utf8");
    const tampered = text.replace(/(\d)Z"/, (_m, d: string) => `${(Number(d) + 1) % 10}Z"`);
    expect(tampered).not.toBe(text);
    writeFileSync(manifestPath, tampered);
    await expect(verify({ dir, publicKey: keys.publicBase64 })).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('pack rejects --key-id "unsigned" as reserved', async () => {
    await expect(
      pack({
        checkoutDir: FIXTURE,
        manifestPath: FIXTURE_MANIFEST,
        outDir: path.join(tempDir("appflare-sign-res-"), "out"),
        install: false,
        keyId: "unsigned",
      }),
    ).rejects.toThrow(/reserved/);
  }, 120_000);
});
