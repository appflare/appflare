import type { CloudflareClient, ContainerApplication } from "@appflare/cf-api";
import { SANDBOX_WORKER_NAME } from "@appflare/schema";
import { readNamespaceState } from "./deploy-plan";

/** Every container application the sandbox Worker makes is named with this prefix. */
export const SANDBOX_APP_PREFIX = `${SANDBOX_WORKER_NAME}-`;

/** A container application by a sandbox name that is not deleted, and why. */
export interface LeftContainerApp {
  id: string;
  name: string;
  reason: string;
}

export interface SandboxContainerApps {
  /** Deleted with the sandbox Worker. */
  apps: ContainerApplication[];
  /** Named like the sandbox Worker's but not shown to be its: left as they are. */
  left: LeftContainerApp[];
}

/**
 * The container applications of the sandbox Worker, which Cloudflare keeps
 * when the Worker is deleted, so disabling sandbox builds and removing
 * Appflare delete them on their own. Found by what they back rather than by
 * the names this version knows: a sandbox Worker deployed by a newer release
 * may have container classes this one has never heard of, whose applications
 * a fixed list of names would leave behind.
 *
 * Among every application of the account (one list call), with every
 * Durable Object namespace (one list call, a page per 1,000):
 * - each one backing a namespace of the sandbox Worker, whatever its class;
 * - each one named with the sandbox prefix (`appflare-sandbox-…`) whose
 *   namespace Cloudflare answers "not found" when read (404, code 10066: one
 *   read call each), left behind by a sandbox Worker deleted earlier,
 *   possibly by a removal stopped between the two, and possibly of a class
 *   this version does not know.
 * Any other one by such a name is left, with the reason: one backing
 * another Worker's namespace is that Worker's, and one whose namespace
 * reads neither as found nor as gone is not deleted on a guess. Read before
 * the sandbox Worker is deleted, since its namespaces go with it. Throws
 * Cloudflare's refusal of either list as it comes (403 for a token without
 * Containers, 401 for an account no longer on Workers Paid).
 */
export async function findSandboxContainerApps(
  api: Pick<CloudflareClient, "containers" | "workers">,
): Promise<SandboxContainerApps> {
  const found: SandboxContainerApps = { apps: [], left: [] };
  const all = await api.containers.listApplications();
  if (all.length === 0) return found;
  const namespaces = new Map(
    (await api.workers.listDurableObjectNamespaces()).map((n) => [n.id, n]),
  );
  for (const app of all) {
    const backs = app.durable_objects?.namespace_id;
    const namespace = backs === undefined ? undefined : namespaces.get(backs);
    if (namespace?.script === SANDBOX_WORKER_NAME) {
      found.apps.push(app);
      continue;
    }
    if (!app.name.startsWith(SANDBOX_APP_PREFIX)) continue;
    const leave = (reason: string) => found.left.push({ id: app.id, name: app.name, reason });
    if (backs === undefined) {
      leave("it backs no Durable Object namespace, so nothing shows it is the sandbox Worker's");
    } else if (namespace !== undefined) {
      leave(`it backs a Durable Object namespace of the Worker ${namespace.script}`);
    } else {
      const read = await readNamespaceState(api, backs);
      if (read.state === "gone") found.apps.push(app);
      else if (read.state === "exists") {
        leave(`the Durable Object namespace it backs (${backs}) still exists`);
      } else {
        leave(
          `Cloudflare did not confirm that the Durable Object namespace it backs (${backs}) is gone: ${read.answer}`,
        );
      }
    }
  }
  return found;
}
