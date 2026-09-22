#!/usr/bin/env node
// Launcher for the `create-appflare` and `appflare` bins (both point here, so
// `npx @appflare/cli <command>` resolves too). Plain JavaScript that any Node
// version parses, so an old Node gets a clear message instead of a syntax
// error; the same check lives in src/node-version.ts.
const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (major < 22) {
  process.stderr.write(
    `Appflare's installer needs Node.js 22 or newer; this is Node.js ${process.versions.node}. ` +
      "Install a current Node.js from https://nodejs.org and run it again.\n",
  );
  process.exit(1);
}
const { existsSync } = await import("node:fs");
const cli = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
  process.stderr.write("appflare: dist/cli.js is missing; run `pnpm build` first\n");
  process.exit(1);
}
await import(cli.href);
