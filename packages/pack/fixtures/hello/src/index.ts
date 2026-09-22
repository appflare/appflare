// Minimal "hello" Worker used as a packer fixture. It has no dependencies so the
// packer can build it with `--no-install`. The Cloudflare runtime types below are
// ambient globals under wrangler's esbuild bundling (which strips types without
// resolving them); this file is intentionally excluded from the workspace
// typecheck/lint (see packages/pack/fixtures/README.md).
interface Env {
  DB: unknown;
  CACHE: unknown;
  GREETING: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const greeting = env.GREETING || "Hello";
    return new Response(`${greeting} from the appflare hello fixture\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
