import { defineConfig, type UserConfig } from "tsdown";

// ESM + .d.ts into dist/. `dependencies` (zod, @noble/hashes) stay external.
const shared = {
  format: "esm",
  tsconfig: "tsconfig.build.json",
  fixedExtension: false,
  dts: { sourcemap: false },
  sourcemap: false,
  // An unresolved import (for example a Node builtin in the neutral entry) is a
  // warning that rolldown turns into an external; fail instead. The TypeScript 7
  // notice is informational.
  failOnWarn: true,
  suppressWarnings: "TypeScript 7.0 does not yet have a stable API",
} satisfies UserConfig;

export default defineConfig([
  // `.`: the API client, which runs inside Workers (the manager). Built for the
  // neutral platform so a stray Node API import fails the build.
  { ...shared, entry: ["src/index.ts"], platform: "neutral", target: "es2023", clean: true },
  // `./capabilities`: the account capability probes alone (HTTP layer and three
  // namespaces), for the CLI, which bundles it and must not pull in the rest.
  {
    ...shared,
    entry: ["src/capabilities.ts"],
    platform: "neutral",
    target: "es2023",
    clean: false,
  },
  // `./dev`: loadDevContext() reads `.env` from disk; Node only.
  { ...shared, entry: ["src/dev.ts"], platform: "node", target: "node22", clean: false },
]);
