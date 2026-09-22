import path from "node:path";
import { parseArgs } from "node:util";
// Explicit `.ts` extension so Node's native type stripping resolves it directly.
import {
  assertNotTrackable,
  generateSigningKeypair,
  writePrivateKeyFile,
} from "./signing-keypair.ts";

/**
 * Generates an artifact signing keypair:
 *
 *   pnpm --filter @appflare/schema keygen --out <file> --key-id <id>
 *
 * Writes the base64 PKCS#8 private key to <file> (mode 0600; refuses to overwrite
 * an existing file or to write into a git working tree where the file would not
 * be ignored) and prints ONLY the file path, the key id, and the base64 raw
 * public key. The private key is never printed. Add the public key to
 * `src/keys.ts` under the key id, and upload the file's contents as the
 * `APPFLARE_SIGNING_KEY` Actions secret (docs/RELEASING.md).
 */
const USAGE = "usage: pnpm --filter @appflare/schema keygen --out <file> --key-id <id>\n";
const KEY_ID = /^[a-z0-9][a-z0-9-]*$/;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
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
    process.stderr.write(`error: --out and --key-id are required\n${USAGE}`);
    return 1;
  }
  if (!KEY_ID.test(keyId) || keyId === "unsigned") {
    process.stderr.write(
      `error: --key-id must be lowercase letters, digits, and dashes, and not "unsigned"\n`,
    );
    return 1;
  }
  // pnpm runs package scripts from the package directory; resolve relative paths
  // against the directory the command was typed in.
  const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.out);

  assertNotTrackable(file);
  const pair = await generateSigningKeypair();
  writePrivateKeyFile(file, pair.privateKeyPkcs8Base64);

  process.stdout.write(`private key: ${file} (mode 0600, base64 PKCS#8; not printed)\n`);
  process.stdout.write(`key id:      ${keyId}\n`);
  process.stdout.write(`public key:  ${pair.publicKeyBase64}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Our own errors never contain key material; the key is only ever written.
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
