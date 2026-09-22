#!/usr/bin/env node
import { register } from "node:module";

// The workspace ships TypeScript source directly (no build step), and packages
// like `@appflare/schema` use extensionless relative imports that Node's native
// TypeScript loader cannot resolve on its own. Register a resolver that appends
// `.ts` before importing any workspace code.
register(new URL("./resolve-ts-extensions.mjs", import.meta.url));

const { main } = await import("./cli-main.ts");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`appflare-pack: ${message}\n`);
  process.exitCode = 1;
}
