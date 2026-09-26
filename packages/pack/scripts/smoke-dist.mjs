// Smoke test for the built package (run by `pnpm test:dist`, which builds
// first). Exercises dist/ exactly as an outside consumer would, with no
// TypeScript loader: imports the library entry, then with the built CLI packs
// fixtures/hello and verifies it, runs the two-step flow (pack with --key-id,
// verify --hashes-only, sign, verify --require-signed --public-key), and makes a
// key pair with keygen (the private key lands in the file, never on stdout).
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const keyDir = mkdtempSync(path.join(tmpdir(), "appflare-smoke-key-"));
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

  const keyFile = path.join(keyDir, "smoke.key");
  const keygen = run(["keygen", "--out", keyFile, "--key-id", "smoke-key"]);
  const privateKey = readFileSync(keyFile, "utf8").trim();
  if (keygen.includes(privateKey)) fail("keygen printed the private key");
  if (!/^public key: +\{"keyId":"smoke-key","publicKeyBase64":"[^"]+"\}$/m.test(keygen)) {
    fail(`unexpected keygen output: ${keygen}`);
  }
  if (!/^fingerprint: SHA256:\S+$/m.test(keygen)) fail(`keygen printed no fingerprint: ${keygen}`);

  process.stdout.write(
    `smoke-dist: ok (${verified.trim()}; two-step: ${signed.trim()}; keygen: ok)\n`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(twoStepDir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
}
