// The one export of @cloudflare/vitest-pool-workers' internal module that
// src/test/between-files.ts uses; `cloudflare:test` re-exports it as `reset`.
declare module "cloudflare:test-internal" {
  export function reset(): Promise<void>;
}
