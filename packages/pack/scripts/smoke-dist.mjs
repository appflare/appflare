// Smoke test for the built package (run by `pnpm test:dist`, which builds
// first). Exercises dist/ exactly as an outside consumer would, with no
// TypeScript loader: imports the library entry, then with the built CLI packs
// fixtures/hello and verifies it, and runs the two-step flow (pack with --key-id,
// verify --hashes-only, sign, verify --require-signed --public-key).
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(pkgDir, "dist", "cli.js");

function fail(message) {
  process.stderr.write(`smoke-dist: ${message}\n`);
  process.exit(1);
}

const lib = await import(path.join(pkgDir, "dist", "index.js"));
for (const name of ["pack", "sign", "verify", "parseJsonc", "ZipStore"]) {
  if (typeof lib[name] !== "function") fail(`dist/index.js does not export ${name}`);
}

function run(args, env = process.env) {
  const res = spawnSync(process.execPath, [cli, ...args], { cwd: pkgDir, encoding: "utf8", env });
  if (res.status !== 0) {
    fail(`\`appflare-pack ${args.join(" ")}\` exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

const outDir = mkdtempSync(path.join(tmpdir(), "appflare-smoke-"));
const twoStepDir = mkdtempSync(path.join(tmpdir(), "appflare-smoke-2step-"));
try {
  run(["--help"]);
  run([
    "fixtures/hello",
    "--manifest",
    "fixtures/hello/appflare.jsonc",
    "--out",
    outDir,
    "--no-install",
  ]);
  const verified = run(["verify", outDir]);
  if (!verified.startsWith("OK:")) fail(`unexpected verify output: ${verified}`);

  // Two-step: pack an unsigned intermediate, then sign it in a separate step.
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
    "base64",
  );
  const pub = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString(
    "base64",
  );
  run([
    "fixtures/hello",
    "--manifest",
    "fixtures/hello/appflare.jsonc",
    "--out",
    twoStepDir,
    "--no-install",
    "--key-id",
    "smoke-key",
  ]);
  run(["verify", twoStepDir, "--hashes-only"]);
  run(["sign", twoStepDir, "--sign-key-env", "SMOKE_SIGN_KEY", "--key-id", "smoke-key"], {
    ...process.env,
    SMOKE_SIGN_KEY: priv,
  });
  const signed = run(["verify", twoStepDir, "--require-signed", "--public-key", pub]);
  if (!signed.includes("signed keyId=smoke-key")) fail(`unexpected verify output: ${signed}`);

  process.stdout.write(`smoke-dist: ok (${verified.trim()}; two-step: ${signed.trim()})\n`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(twoStepDir, { recursive: true, force: true });
}
