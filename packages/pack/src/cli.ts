#!/usr/bin/env node
import { main } from "./cli-main.ts";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`appflare-pack: ${message}\n`);
  process.exitCode = 1;
}
