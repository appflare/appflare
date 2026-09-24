import {
  type ArtifactManifest,
  SANDBOX_BUCKET_BINDING,
  SANDBOX_BUCKET_NAME,
  SANDBOX_WORKER_NAME,
  sandboxImage,
} from "@appflare/schema";
import { UNPACKED_WORKER_DIR } from "./artifact.ts";
import type { VersionBinding } from "./worker-info.ts";
import { moduleRules, type WranglerRuleType } from "./wrangler-config.ts";

/**
 * The container classes of the sandbox Worker: builds run on `standard-1`
 * (1/2 vCPU, 4 GiB, 8 GB disk), and on `standard-2` when a catalog entry asks
 * for it. At most two builds of the first size and one of the second run at
 * once. Each class is a Durable Object backed by the sandbox Worker image.
 */
export const SANDBOX_CONTAINERS = [
  {
    name: `${SANDBOX_WORKER_NAME}-standard-1`,
    class_name: "Sandbox",
    instance_type: "standard-1",
    max_instances: 2,
  },
  {
    name: `${SANDBOX_WORKER_NAME}-standard-2`,
    class_name: "LargeSandbox",
    instance_type: "standard-2",
    max_instances: 1,
  },
] as const;

/** The `wrangler.json` `appflare sandbox enable` deploys the sandbox Worker with. */
export interface SandboxWranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  no_bundle: true;
  find_additional_modules: true;
  base_dir: string;
  rules: { type: WranglerRuleType; globs: string[] }[];
  /** Reached only through the manager's service binding: no public URL. */
  workers_dev: false;
  preview_urls: false;
  send_metrics: false;
  observability?: Record<string, unknown>;
  containers: {
    name: string;
    class_name: string;
    image: string;
    instance_type: string;
    max_instances: number;
  }[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: Record<string, unknown>[];
  /** With a name and no id: wrangler creates the bucket on the first deploy and reuses it after. */
  r2_buckets: { binding: string; bucket_name: string }[];
  vars: { APPFLARE_VERSION: string };
}

/**
 * The deploy config for a verified sandbox Worker artifact. The artifact must carry
 * exactly the bindings this config declares (the two Sandbox classes, the
 * build bucket, and its version); anything else means a sandbox Worker newer than
 * this CLI, which is refused rather than deployed half-configured.
 */
export function buildSandboxWranglerConfig(manifest: ArtifactManifest): SandboxWranglerConfig {
  const { worker } = manifest;
  const expected = new Set([
    ...SANDBOX_CONTAINERS.map((c) => `durable_object_namespace:${c.class_name}`),
    `r2_bucket:${SANDBOX_BUCKET_BINDING}`,
    "plain_text:APPFLARE_VERSION",
  ]);
  for (const binding of worker.bindings) {
    const key = `${binding.type}:${binding.name}`;
    if (!expected.delete(key)) {
      throw new Error(
        `the sandbox Worker artifact has a ${binding.type} binding (${binding.name}) this version of ` +
          "the CLI does not know; run the latest @appflare/cli",
      );
    }
    if (binding.type === "plain_text" && binding.text !== manifest.version) {
      throw new Error(
        `the sandbox Worker artifact's APPFLARE_VERSION is ${JSON.stringify(binding.text)}, not ${manifest.version}`,
      );
    }
  }
  if (expected.size > 0) {
    throw new Error(`the sandbox Worker artifact lacks the binding(s) ${[...expected].join(", ")}`);
  }

  const image = sandboxImage(manifest.version);
  return {
    name: SANDBOX_WORKER_NAME,
    main: `${UNPACKED_WORKER_DIR}/${worker.mainModule}`,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: [...worker.compatibilityFlags],
    // The modules are wrangler's own build output: upload them as they are.
    no_bundle: true,
    find_additional_modules: true,
    base_dir: UNPACKED_WORKER_DIR,
    rules: moduleRules(worker.modules),
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    ...(worker.observability ? { observability: { ...worker.observability } } : {}),
    containers: SANDBOX_CONTAINERS.map((c) => ({ ...c, image })),
    durable_objects: {
      bindings: SANDBOX_CONTAINERS.map((c) => ({ name: c.class_name, class_name: c.class_name })),
    },
    migrations: worker.migrations.map((m) => ({ ...m })),
    r2_buckets: [{ binding: SANDBOX_BUCKET_BINDING, bucket_name: SANDBOX_BUCKET_NAME }],
    vars: { APPFLARE_VERSION: manifest.version },
  };
}

/**
 * Whether a deployed Worker version is an Appflare sandbox Worker: the Sandbox
 * Durable Object, the build bucket, and a version. A Worker that merely
 * shares the name is never updated or deleted.
 */
export function hasSandboxBindings(bindings: VersionBinding[]): boolean {
  const has = (type: string, name: string) =>
    bindings.some((b) => b.type === type && b.name === name);
  return (
    has("durable_object_namespace", "Sandbox") &&
    has("r2_bucket", SANDBOX_BUCKET_BINDING) &&
    has("plain_text", "APPFLARE_VERSION")
  );
}

const PLANS_URL = "https://dash.cloudflare.com/?to=/:account/workers/plans";

/** What the credential wrangler deploys with is, for wording an access failure. */
export interface DeployCredential {
  /** An API token from the environment (`CLOUDFLARE_API_TOKEN`), rather than a `wrangler login`. */
  apiToken: boolean;
}

/**
 * Why Cloudflare refused Containers, for both an access failure at wrangler's
 * container application step and a refused pre-deploy check. With an API
 * token either cause fits, so both are named with how to check each; a
 * `wrangler login` already carries the Containers scope, which leaves the plan.
 */
export function explainContainersAccess(credential: DeployCredential): string {
  const again = "then run `npx @appflare/cli sandbox enable` again.";
  if (!credential.apiToken) {
    return (
      "Cloudflare refused access to Containers, which the sandbox Worker runs builds in. " +
      "Sandbox builds need Workers Paid (US$5 a month): the free plan does not include " +
      `Containers. Check the account's plan at ${PLANS_URL} and upgrade it there, ${again} ` +
      "If the account is already on Workers Paid, log in again with `npx wrangler login` so " +
      "the login includes Containers."
    );
  }
  return [
    "Cloudflare refused access to Containers, which the sandbox Worker runs builds in. " +
      "With an API token there are two possible causes; check both:",
    `1. The account is not on Workers Paid (US$5 a month); the free plan does not include Containers. Check the plan at ${PLANS_URL}.`,
    "2. The API token in CLOUDFLARE_API_TOKEN lacks the Containers permission. Open the token " +
      "(My Profile > API Tokens at https://dash.cloudflare.com/profile/api-tokens, or Manage " +
      "Account > Account API Tokens for an account token) and make sure it has Account > " +
      "Containers > Edit next to Workers Scripts > Edit and Workers R2 Storage > Edit. Or unset " +
      "CLOUDFLARE_API_TOKEN and use `npx wrangler login`, which includes Containers.",
    `Fix the cause, ${again}`,
  ].join("\n");
}

/** Cloudflare's plan answers for Containers, in whatever step they come. */
const PAID_PATTERNS = [
  /Container image preparation is not enabled/i,
  /Workers Paid/i,
  /containers?\b[^\n]{0,120}\b(not enabled|not available|not entitled|paid plan|subscription|upgrade)/i,
  /\b(not entitled|entitlement)\b[^\n]{0,120}\bcontainers?\b/i,
];

/** wrangler's heading for the step that creates or updates the container applications. */
const CONTAINER_STEP = "Deploy a container application";

/**
 * Whether wrangler's deploy failed at its container application step with an
 * access or plan error. wrangler words a 401 from the Containers API as a
 * bare "Unauthorized" and a 403 as "Forbidden", with nothing that says which
 * cause it is.
 */
export function isContainerAccessFailure(output: string): boolean {
  const at = output.indexOf(CONTAINER_STEP);
  if (at === -1) {
    return false;
  }
  const after = output.slice(at + CONTAINER_STEP.length);
  return (
    /\b(Unauthorized|Forbidden)\b|\b(401|403)\b/.test(after) ||
    PAID_PATTERNS.some((pattern) => pattern.test(after))
  );
}

/**
 * Cloudflare's answer when the account cannot run the sandbox Worker, reworded:
 * Containers need Workers Paid (and, for an API token, the Containers
 * permission), and R2 must be enabled once in the dashboard. Null when the
 * output says none of these.
 */
export function explainSandboxDeployFailure(
  output: string,
  credential: DeployCredential = { apiToken: false },
): string | null {
  // A message that names the plan is unambiguous; a bare refusal at the
  // container step could be the plan or the token.
  if (PAID_PATTERNS.some((pattern) => pattern.test(output))) {
    return (
      "Sandbox builds need Workers Paid. The sandbox Worker runs builds in Cloudflare Containers, " +
      "which are only available on the Workers Paid plan (US$5 a month). Upgrade the account " +
      `at ${PLANS_URL}, then run \`npx @appflare/cli sandbox enable\` again.`
    );
  }
  if (isContainerAccessFailure(output)) {
    return explainContainersAccess(credential);
  }
  if (/\bcode: 10042\b|enable R2/i.test(output)) {
    return (
      "R2 is not enabled on this account. The sandbox Worker keeps build outputs in an R2 bucket: " +
      "open R2 in the Cloudflare dashboard once to enable it " +
      "(https://dash.cloudflare.com/?to=/:account/r2/overview), then run " +
      "`npx @appflare/cli sandbox enable` again."
    );
  }
  return null;
}
