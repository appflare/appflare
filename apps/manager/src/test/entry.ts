/**
 * Worker entry for `@cloudflare/vitest-pool-workers` only. The real entry
 * (src/worker.ts) imports TanStack Start's virtual server modules, which exist
 * only under the Start Vite plugin; tests exercise the modules directly and only
 * need the classes behind the `JOBS` and `SELF` bindings to exist.
 */
export { JobWorkflow } from "../jobs/job-workflow";
export { JobUnits } from "../jobs/units/entrypoint";

export default {
  fetch: () => new Response("test entry", { status: 404 }),
} satisfies ExportedHandler<Env>;
