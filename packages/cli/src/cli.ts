#!/usr/bin/env node
import { main } from "./main.ts";
import { terminalUi } from "./ui.ts";

process.exitCode = await main(process.argv.slice(2), {
  ui: terminalUi(process.env),
  env: process.env,
  fetch: (url, init) => fetch(url, init),
});
