// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// SETUP_TOKEN is deleted after setup and CF_API_TOKEN only exists after it,
// so both are optional. Declared on both `Cloudflare.Env` (the type of
// `import { env } from "cloudflare:workers"`) and the global `Env`.
interface ManagerSecrets {
  BETTER_AUTH_SECRET: string;
  SETUP_TOKEN?: string;
  CF_API_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env extends ManagerSecrets {}
}

interface Env extends ManagerSecrets {}

// Workers' non-standard constant-time compare. The DOM lib (needed by the React
// code in the same program) owns the global `crypto` type and lacks it.
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}
