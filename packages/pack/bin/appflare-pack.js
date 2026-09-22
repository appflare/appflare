#!/usr/bin/env node
// Committed launcher for the `appflare-pack` bin. pnpm links workspace bins at
// install time, before `dist/` exists on a fresh clone; pointing `bin` at this
// file (instead of dist/cli.js directly) keeps the link valid across builds.
import { existsSync } from "node:fs";

const cli = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
  process.stderr.write("appflare-pack: dist/cli.js is missing; run `pnpm build` first\n");
  process.exit(1);
}
await import(cli.href);
