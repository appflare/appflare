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
 * Read-only views of the account, through wrangler's `--json` output (wrangler
 * 4.136 prints the Cloudflare API objects unchanged): what the installer
 * checks before it deploys.
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

export async function listD1Databases(wrangler: Wrangler): Promise<D1Database[]> {
  const result = await runOk(wrangler, wranglerArgs.d1List());
  return d1ListSchema.parse(parseJsonOutput("d1 list", result.stdout));
}

export async function listKvNamespaces(wrangler: Wrangler): Promise<KvNamespace[]> {
  const result = await runOk(wrangler, wranglerArgs.kvList());
  return kvListSchema.parse(parseJsonOutput("kv namespace list", result.stdout));
}
