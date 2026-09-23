import { parseArgs } from "node:util";
import { MAX_WORKER_MODULES } from "@appflare/schema";
import { pack } from "./pack.ts";
import { sign } from "./sign.ts";
import { verify } from "./verify.ts";

const USAGE = `appflare-pack — build, sign, and verify Appflare artifacts

Usage:
  appflare-pack <checkoutDir> --manifest <appflare.jsonc> --out <dir> [--key-id ID [--sign-key-env NAME]] [--no-install]
  appflare-pack sign <dir> --sign-key-env NAME [--key-id ID] [--force]
  appflare-pack verify <dir> [--public-key <base64>] [--require-signed | --hashes-only] [--max-modules <n>]

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

Verify options:
  --public-key <base64>   raw Ed25519 public key to verify against
  --require-signed        fail if the artifact is unsigned or has no manifest.sig
  --hashes-only           skip signature checks; still check sizes, hashes, offsets
  --max-modules <n>       fail if the Worker has more than <n> modules. Appflare
                          uploads at most ${MAX_WORKER_MODULES} (the free plan's subrequest limit);
                          pass ${MAX_WORKER_MODULES} to reject artifacts it could never install.
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
  process.stdout.write(`  zip:       ${result.zipPath} (${result.zipSize} bytes)\n`);
  process.stdout.write(`  manifest:  ${result.manifestJsonPath}\n`);
  if (result.signaturePath) {
    process.stdout.write(`  signature: ${result.signaturePath}\n`);
  }
  process.stdout.write(
    `  modules=${result.moduleCount} assets=${result.assetCount} migrations=${result.d1MigrationCount}\n`,
  );
  for (const warning of result.warnings) {
    process.stdout.write(`  warning: ${warning}\n`);
  }
  return 0;
}

/** `--max-modules`: a positive integer, or undefined when not given. */
export function parseMaxModules(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`--max-modules must be a positive integer, got "${value}"`);
  }
  return n;
}

async function runVerify(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "public-key": { type: "string" },
      "require-signed": { type: "boolean" },
      "hashes-only": { type: "boolean" },
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
  const result = await verify({
    dir,
    publicKey: values["public-key"],
    requireSigned: values["require-signed"],
    hashesOnly: values["hashes-only"],
    maxModules: parseMaxModules(values["max-modules"]),
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
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  return runPack(argv);
}
