import { z } from "zod";
import {
  isWorkerNotFound,
  parseJsonOutput,
  runOk,
  type Wrangler,
  WranglerError,
  wranglerArgs,
} from "./wrangler.ts";

/**
 * Read-only views of a deployed manager through wrangler's `--json` output
 * (wrangler 4.136 prints the Cloudflare API objects unchanged).
 */

const deploymentSchema = z.looseObject({
  id: z.string(),
  created_on: z.string(),
  source: z.string().optional(),
  author_email: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  versions: z.array(z.looseObject({ version_id: z.string(), percentage: z.number() })),
});
export type Deployment = z.infer<typeof deploymentSchema>;

const versionSchema = z.looseObject({
  id: z.string(),
  number: z.number().optional(),
  metadata: z.looseObject({
    created_on: z.string(),
    source: z.string().optional(),
    author_email: z.string().optional(),
  }),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type Version = z.infer<typeof versionSchema>;

const versionDetailSchema = versionSchema.extend({
  resources: z.looseObject({
    bindings: z.array(z.looseObject({ type: z.string(), name: z.string() })),
  }),
});
export type VersionDetail = z.infer<typeof versionDetailSchema>;
export type VersionBinding = VersionDetail["resources"]["bindings"][number];

const d1ListSchema = z.array(z.looseObject({ uuid: z.string(), name: z.string() }));
const kvListSchema = z.array(z.looseObject({ id: z.string(), title: z.string() }));

export type D1Database = { uuid: string; name: string };
export type KvNamespace = { id: string; title: string };

/** Deployments of `worker`, oldest first; null when the Worker does not exist. */
export async function listDeployments(
  wrangler: Wrangler,
  worker: string,
): Promise<Deployment[] | null> {
  const args = wranglerArgs.deploymentsList(worker);
  const result = await wrangler.run(args);
  if (result.code !== 0) {
    if (isWorkerNotFound(result)) {
      return null;
    }
    throw new WranglerError("deployments list", result);
  }
  return z
    .array(deploymentSchema)
    .parse(parseJsonOutput("deployments list", result.stdout))
    .sort((a, b) => a.created_on.localeCompare(b.created_on));
}

/** Recent versions of `worker`, oldest first. */
export async function listVersions(wrangler: Wrangler, worker: string): Promise<Version[]> {
  const result = await runOk(wrangler, wranglerArgs.versionsList(worker));
  return z
    .array(versionSchema)
    .parse(parseJsonOutput("versions list", result.stdout))
    .sort((a, b) => a.metadata.created_on.localeCompare(b.metadata.created_on));
}

/** One version with its bindings. */
export async function viewVersion(
  wrangler: Wrangler,
  worker: string,
  versionId: string,
): Promise<VersionDetail> {
  const result = await runOk(wrangler, wranglerArgs.versionsView(worker, versionId));
  return versionDetailSchema.parse(parseJsonOutput("versions view", result.stdout));
}

export async function listD1Databases(wrangler: Wrangler): Promise<D1Database[]> {
  const result = await runOk(wrangler, wranglerArgs.d1List());
  return d1ListSchema.parse(parseJsonOutput("d1 list", result.stdout));
}

export async function listKvNamespaces(wrangler: Wrangler): Promise<KvNamespace[]> {
  const result = await runOk(wrangler, wranglerArgs.kvList());
  return kvListSchema.parse(parseJsonOutput("kv namespace list", result.stdout));
}

/** The version serving 100% of traffic in the newest deployment, if any. */
export function activeVersionId(deployments: Deployment[]): string | null {
  const latest = deployments.at(-1);
  return (
    latest?.versions.find((v) => v.percentage === 100)?.version_id ??
    latest?.versions[0]?.version_id ??
    null
  );
}

/**
 * The version `wrangler rollback` would pick by default: the 100% version of
 * the newest deployment before the current one (wrangler's
 * fetchDefaultRollbackVersionId), skipping deployments that split traffic.
 */
export function previousVersionId(deployments: Deployment[]): string | null {
  for (const deployment of deployments.slice(0, -1).reverse()) {
    const stable = deployment.versions.find((v) => v.percentage === 100);
    if (stable) {
      return stable.version_id;
    }
  }
  return null;
}

/** `APPFLARE_VERSION` of a deployed version, from its plain-text binding. */
export function appflareVersionOf(version: VersionDetail): string | null {
  const binding = version.resources.bindings.find(
    (b) => b.type === "plain_text" && b.name === "APPFLARE_VERSION",
  );
  return typeof binding?.text === "string" ? binding.text : null;
}
