/**
 * The bindings of wrangler.jsonc (and of the config `appflare sandbox enable`
 * generates, which declares the same ones). Keep the two in step.
 *
 * Besides these, the manager sets secrets per self-deploying install
 * (`APP_TOKEN_<installId>`, `APP_SECRET_<installId>_<name>`) through the Cloudflare
 * API; their names are not known in advance, so self-managed.ts reads them by
 * name instead of through this interface.
 */
interface Env {
  /** Build outputs and logs, under builds/<installId>/<version>/. */
  BUILDS: R2Bucket;
  /** This Worker's Appflare version; also the tag of the image its containers run. */
  APPFLARE_VERSION: string;
  /** Sandbox containers on `standard-1`. */
  Sandbox: DurableObjectNamespace<import("./sandbox").Sandbox>;
  /** Sandbox containers on `standard-2`. */
  LargeSandbox: DurableObjectNamespace<import("./sandbox").LargeSandbox>;
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
  interface GlobalProps {
    /** Types `exports` from "cloudflare:workers" (the tests call the entrypoint through it). */
    mainModule: typeof import("./index");
    durableNamespaces: "Sandbox" | "LargeSandbox";
  }
}
