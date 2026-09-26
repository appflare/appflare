import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePublicKeys, publicKeyFingerprint } from "@appflare/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli-main.ts";
import { keygen, keyIdProblem } from "./keygen.ts";
import { publicKeyFromPrivate, signBytes } from "./signing.ts";

const scratch: string[] = [];
function tempDir(prefix = "appflare-keygen-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

/** Runs the CLI with stdout and stderr captured. */
async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await main(argv);
    return { code, stdout, stderr };
  } finally {
    vi.restoreAllMocks();
  }
}

describe("keygen", () => {
  it("writes a usable private key with mode 0600 and returns only public values", async () => {
    const file = path.join(tempDir(), "signing.key");
    const result = await keygen({ out: file, keyId: "acme-2026-09" });

    expect(result.privateKeyPath).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const privateKey = readFileSync(file, "utf8").trim();
    const [key] = parsePublicKeys(result.publicKeyLine);
    expect(key?.keyId).toBe("acme-2026-09");
    // The file holds the private half of exactly the printed public key.
    expect(await publicKeyFromPrivate(privateKey)).toBe(key?.publicKeyBase64);
    await expect(signBytes(new Uint8Array([1, 2, 3]), privateKey)).resolves.toMatch(/=$/);
    expect(result.fingerprint).toBe(await publicKeyFingerprint(key?.publicKeyBase64 ?? ""));
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it("resolves a relative path against cwd", async () => {
    const dir = tempDir();
    const result = await keygen({ out: "relative.key", keyId: "acme", cwd: dir });
    expect(result.privateKeyPath).toBe(path.join(dir, "relative.key"));
    expect(statSync(result.privateKeyPath).isFile()).toBe(true);
  });

  it("refuses to overwrite an existing file and leaves it untouched", async () => {
    const file = path.join(tempDir(), "existing.key");
    writeFileSync(file, "keep me\n");
    await expect(keygen({ out: file, keyId: "acme" })).rejects.toThrow(/already exists/);
    expect(readFileSync(file, "utf8")).toBe("keep me\n");
  });

  it("refuses a path git would track, and allows a gitignored one", async () => {
    const repo = tempDir("appflare-keygen-repo-");
    git(repo, "init", "-q");
    await expect(keygen({ out: path.join(repo, "signing.key"), keyId: "acme" })).rejects.toThrow(
      /not gitignored/,
    );
    expect(() => statSync(path.join(repo, "signing.key"))).toThrow();

    writeFileSync(path.join(repo, ".gitignore"), "*.key\n");
    const result = await keygen({ out: path.join(repo, "ignored.key"), keyId: "acme" });
    expect(statSync(result.privateKeyPath).mode & 0o777).toBe(0o600);
  });

  it("refuses a directory that does not exist", async () => {
    const file = path.join(tempDir(), "missing", "signing.key");
    await expect(keygen({ out: file, keyId: "acme" })).rejects.toThrow(/does not exist/);
  });

  it.each(["unsigned", "Acme", "acme_2026", "-acme", "", "a".repeat(64)])(
    "refuses the key id %j",
    async (keyId) => {
      expect(keyIdProblem(keyId)).not.toBeNull();
      const file = path.join(tempDir(), "signing.key");
      await expect(keygen({ out: file, keyId })).rejects.toThrow(/--key-id/);
      expect(() => statSync(file)).toThrow();
    },
  );

  it.each(["acme", "acme-2026-09", "0", "a".repeat(63)])("accepts the key id %j", (keyId) => {
    expect(keyIdProblem(keyId)).toBeNull();
  });
});

describe("appflare-pack keygen", () => {
  it("prints the path, key id, paste line and fingerprint, never the private key", async () => {
    const dir = tempDir();
    vi.stubEnv("INIT_CWD", dir);
    const { code, stdout, stderr } = await runCli([
      "keygen",
      "--out",
      "catalog.key",
      "--key-id",
      "acme-2026-09",
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");

    const file = path.join(dir, "catalog.key");
    const privateKey = readFileSync(file, "utf8").trim();
    expect(privateKey.length).toBeGreaterThan(40);
    expect(stdout).not.toContain(privateKey);
    // Nor any sizeable piece of it.
    expect(stdout).not.toContain(privateKey.slice(-32));

    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`private key: ${file} (mode 0600, base64 PKCS#8; not printed)`);
    expect(lines[1]).toBe("key id:      acme-2026-09");

    const pasteLine = lines[2]?.replace(/^public key: +/, "") ?? "";
    const keys = parsePublicKeys(pasteLine);
    expect(keys).toEqual([
      { keyId: "acme-2026-09", publicKeyBase64: await publicKeyFromPrivate(privateKey) },
    ]);
    expect(lines[3]).toBe(
      `fingerprint: ${await publicKeyFingerprint(keys[0]?.publicKeyBase64 ?? "")}`,
    );
    expect(lines[3]).toMatch(/^fingerprint: SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("requires --out and --key-id", async () => {
    const { code, stderr } = await runCli(["keygen", "--key-id", "acme"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--out and --key-id are required");
  });

  it("rejects an invalid key id before writing anything", async () => {
    const file = path.join(tempDir(), "signing.key");
    await expect(runCli(["keygen", "--out", file, "--key-id", "unsigned"])).rejects.toThrow(
      /--key-id/,
    );
    expect(() => statSync(file)).toThrow();
  });
});
