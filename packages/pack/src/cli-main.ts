import { parseArgs } from "node:util";
import {
  INSPECT_OUTPUT_PREFIX,
  MAX_WORKER_UPLOAD_BYTES,
  MAX_WORKER_UPLOAD_SUBREQUESTS,
} from "@appflare/schema";
import { inspectWranglerConfig } from "./inspect.ts";
import { formatKeygenOutput, keygen } from "./keygen.ts";
import { describeVersionOrigin, pack } from "./pack.ts";
import { sign } from "./sign.ts";
import { verify } from "./verify.ts";
import { formatBytes, workerSizeLine } from "./worker-size.ts";

const USAGE = `appflare-pack — build, sign, and verify Appflare artifacts, and make signing keys

Usage:
  appflare-pack <checkoutDir> --manifest <appflare.jsonc> --out <dir> [--key-id ID [--sign-key-env NAME]] [--no-install]
  appflare-pack sign <dir> --sign-key-env NAME [--key-id ID] [--force]
  appflare-pack verify <dir> [--public-key <base64>] [--require-signed | --hashes-only] [--check-upload]
  appflare-pack inspect <checkoutDir> --config <wrangler config>
  appflare-pack keygen --out <file> --key-id <id>

Pack options:
  --manifest <path>       catalog manifest (appflare.jsonc)      (required)
  --out <dir>             output directory for the artifact      (required)
  --key-id <id>           key id recorded in manifest.keyId (default "unsigned")
  --sign-key-env <NAME>   env var holding a base64 PKCS#8 Ed25519 private key;
                          signs in the same step (requires --key-id). Without it,
                          --key-id yields an unsigned intermediate for \`sign\`.
  --no-install            skip installing the checkout's dependencies

Sign options (signs <dir>/manifest.json as-is, writes manifest.sig, self-verifies):
  --sign-key-env <NAME>   env var holding the private key            (required)
  --key-id <id>           must equal manifest.keyId
  --force                 overwrite an existing manifest.sig

Inspect options (prints the config's name, plain vars and the sections the
packer leaves out, as JSON after "${INSPECT_OUTPUT_PREFIX.trim()}"):
  --config <path>         the wrangler config, relative to <checkoutDir> (required)

Keygen options (writes a new Ed25519 private key, base64 PKCS#8, to <file> with
mode 0600; never overwrites a file or writes where git would track it; prints the
key id, the public key line a catalog publishes, and its fingerprint, never the
private key):
  --out <file>            where to write the private key; keep it outside every
                          repository                                 (required)
  --key-id <id>           key id recorded in each manifest signed with this key:
                          lowercase letters, digits and dashes      (required)

Verify options:
  --public-key <base64>   raw Ed25519 public key to verify against
  --require-signed        fail if the artifact is unsigned or has no manifest.sig
  --hashes-only           skip signature checks; still check sizes, hashes, offsets
  --check-upload          fail if a Worker does not fit one Appflare upload: at most
                          ${formatBytes(MAX_WORKER_UPLOAD_BYTES)} of modules, read with at most ${MAX_WORKER_UPLOAD_SUBREQUESTS} subrequests
                          (the release redirect and one per range of adjacent modules).
                          The module count itself is not limited.
  --max-modules <n>       deprecated: does what --check-upload does; <n> is ignored.
`;

const logToStderr = (message: string): void => {
  process.stderr.write(`- ${message}\n`);
};

async function runPack(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      manifest: { type: "string" },
      out: { type: "string" },
      "sign-key-env": { type: "string" },
      "key-id": { type: "string" },
      "no-install": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const checkoutDir = positionals[0];
  if (!checkoutDir) {
    process.stderr.write(`error: missing <checkoutDir>\n\n${USAGE}`);
    return 1;
  }
  if (!values.manifest) {
    process.stderr.write(`error: --manifest is required\n\n${USAGE}`);
    return 1;
  }
  if (!values.out) {
    process.stderr.write(`error: --out is required\n\n${USAGE}`);
    return 1;
  }
  if (values["sign-key-env"] && !values["key-id"]) {
    process.stderr.write("error: --key-id is required when signing with --sign-key-env\n");
    return 1;
  }

  const result = await pack({
    checkoutDir,
    manifestPath: values.manifest,
    outDir: values.out,
    install: !values["no-install"],
    signKeyEnv: values["sign-key-env"],
    keyId: values["key-id"],
    logger: logToStderr,
  });

  process.stdout.write(`${result.slug}@${result.version}\n`);
  process.stdout.write(`  version:   ${describeVersionOrigin(result.versionOrigin)}\n`);
  process.stdout.write(`  zip:       ${result.zipPath} (${result.zipSize} bytes)\n`);
  process.stdout.write(`  manifest:  ${result.manifestJsonPath}\n`);
  if (result.signaturePath) {
    process.stdout.write(`  signature: ${result.signaturePath}\n`);
  }
  process.stdout.write(
    `  modules=${result.moduleCount} assets=${result.assetCount} migrations=${result.d1MigrationCount}\n`,
  );
  if (result.workers.length > 1) {
    for (const w of result.workers) {
      const label = `${w.name ?? ""}${w.primary ? " (primary)" : ""}`;
      process.stdout.write(`  worker ${label}: ${workerSizeLine(w.workerSize, w.moduleCount)}\n`);
    }
  } else {
    process.stdout.write(`  worker:    ${workerSizeLine(result.workerSize, result.moduleCount)}\n`);
  }
  return 0;
}

/**
 * What `verify` prints on stderr for `--max-modules`: Appflare no longer
 * limits the module count, so the flag only turns on the upload check.
 */
export const MAX_MODULES_DEPRECATION =
  "--max-modules is deprecated and its value is ignored: Cloudflare has no module count " +
  "limit, and Appflare checks what an upload costs instead (subrequests and memory). " +
  "It does what --check-upload does; pass that instead.";

async function runVerify(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "public-key": { type: "string" },
      "require-signed": { type: "boolean" },
      "hashes-only": { type: "boolean" },
      "check-upload": { type: "boolean" },
      // Deprecated; still accepted because existing catalog workflows pass it.
      "max-modules": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dir = positionals[0];
  if (!dir) {
    process.stderr.write(`error: missing <dir>\n\n${USAGE}`);
    return 1;
  }
  if (values["max-modules"] !== undefined) {
    logToStderr(MAX_MODULES_DEPRECATION);
  }
  const result = await verify({
    dir,
    publicKey: values["public-key"],
    requireSigned: values["require-signed"],
    hashesOnly: values["hashes-only"],
    checkUpload: values["check-upload"] === true || values["max-modules"] !== undefined,
    logger: logToStderr,
  });
  process.stdout.write(
    `OK: ${result.checkedFiles} files verified (${result.signed ? `signed keyId=${result.keyId}` : "unsigned"})\n`,
  );
  return 0;
}

async function runSign(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "sign-key-env": { type: "string" },
      "key-id": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dir = positionals[0];
  if (!dir) {
    process.stderr.write(`error: missing <dir>\n\n${USAGE}`);
    return 1;
  }
  if (!values["sign-key-env"]) {
    process.stderr.write(`error: --sign-key-env is required\n\n${USAGE}`);
    return 1;
  }
  const result = await sign({
    dir,
    signKeyEnv: values["sign-key-env"],
    keyId: values["key-id"],
    force: values.force,
    logger: logToStderr,
  });
  process.stdout.write(`signed: ${result.signaturePath} (keyId=${result.keyId})\n`);
  process.stdout.write(`  public key: ${result.publicKey}\n`);
  process.stdout.write(`  self-check: OK, ${result.checkedFiles} files verified\n`);
  return 0;
}

async function runInspect(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const checkoutDir = positionals[0];
  if (!checkoutDir || !values.config) {
    process.stderr.write(`error: <checkoutDir> and --config are required\n\n${USAGE}`);
    return 1;
  }
  const facts = inspectWranglerConfig(checkoutDir, values.config);
  process.stdout.write(`${INSPECT_OUTPUT_PREFIX}${JSON.stringify(facts)}\n`);
  return 0;
}

async function runKeygen(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      "key-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const keyId = values["key-id"];
  if (!values.out || !keyId) {
    process.stderr.write(`error: --out and --key-id are required\n\n${USAGE}`);
    return 1;
  }
  // A package script runs in the package's directory; pnpm and npm set
  // INIT_CWD to where the command was typed, which a relative --out means.
  const result = await keygen({
    out: values.out,
    keyId,
    cwd: process.env.INIT_CWD ?? process.cwd(),
  });
  process.stdout.write(formatKeygenOutput(result));
  return 0;
}

/** CLI entrypoint. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (argv[0] === "verify") {
    return runVerify(argv.slice(1));
  }
  if (argv[0] === "sign") {
    return runSign(argv.slice(1));
  }
  if (argv[0] === "inspect") {
    return runInspect(argv.slice(1));
  }
  if (argv[0] === "keygen") {
    return runKeygen(argv.slice(1));
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  return runPack(argv);
}
