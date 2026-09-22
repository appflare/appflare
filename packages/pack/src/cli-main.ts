import { parseArgs } from "node:util";
import { pack } from "./pack.ts";
import { verify } from "./verify.ts";

const USAGE = `appflare-pack — build and verify Appflare artifacts

Usage:
  appflare-pack <checkoutDir> --manifest <appflare.jsonc> --out <dir> [--sign-key-env NAME --key-id ID] [--no-install]
  appflare-pack verify <dir> [--public-key <base64>]

Pack options:
  --manifest <path>       catalog manifest (appflare.jsonc)      (required)
  --out <dir>             output directory for the artifact      (required)
  --sign-key-env <NAME>   env var holding a base64 PKCS#8 Ed25519 private key
  --key-id <id>           key id recorded in manifest.keyId      (required with --sign-key-env)
  --no-install            skip installing the checkout's dependencies

Verify options:
  --public-key <base64>   raw Ed25519 public key to verify against
  --require-signed        fail if the artifact is unsigned or has no manifest.sig
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
  return 0;
}

async function runVerify(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "public-key": { type: "string" },
      "require-signed": { type: "boolean" },
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
    logger: logToStderr,
  });
  process.stdout.write(
    `OK: ${result.checkedFiles} files verified (${result.signed ? `signed keyId=${result.keyId}` : "unsigned"})\n`,
  );
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
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  return runPack(argv);
}
