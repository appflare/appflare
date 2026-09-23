import type { WorkerBinding } from "@appflare/schema";
import { and, eq } from "drizzle-orm";
import { resources } from "../../db/schema";
import { RATE_LIMIT_KIND } from "../../installs/resource-kinds";
import type { JobSteps } from "../steps";
import { resourceId } from "./phases";

/**
 * Rate limit namespaces. A `ratelimit` binding names its counters with a
 * `namespace_id`, and Cloudflare shares the counters of one id across every
 * Worker in the account that binds it. The id in an app's wrangler config is
 * whatever its author picked (often `1001`), so two installs of one app, or
 * two apps that picked the same number, would throttle each other. Each
 * install therefore gets an id of its own per rate limit binding, recorded as
 * a `ratelimit` resource (binding name, id as its Cloudflare id) and reused by
 * every later update. A rollback redeploys a version that already carries the
 * install's ids. The counters live only as long as the Worker binds them, so
 * the record goes with the Worker on uninstall.
 */

/** The largest id Appflare assigns: the largest positive signed 32-bit integer. */
const MAX_NAMESPACE_ID = 2_147_483_647;

/** A random rate limit namespace id, 1 to 2^31-1, as the decimal string the upload sends. */
export function randomNamespaceId(): string {
  const [n = 0] = crypto.getRandomValues(new Uint32Array(1));
  return String((n % MAX_NAMESPACE_ID) + 1);
}

/** The binding names of the Worker's rate limits. */
export function rateLimitBindings(bindings: readonly WorkerBinding[]): string[] {
  return bindings.filter((b) => b.type === "ratelimit").map((b) => b.name);
}

/**
 * Step "assign rate limit namespaces": the install's id for each rate limit
 * binding, by binding name. Ids already recorded for the install are reused;
 * a binding without one gets a new random id, recorded in the same step, so a
 * retried step reads back what its earlier attempt recorded.
 */
export async function assignRateLimitsPhase(
  steps: JobSteps,
  installId: string,
  bindings: readonly WorkerBinding[],
): Promise<Record<string, string>> {
  const names = rateLimitBindings(bindings);
  if (names.length === 0) return {};
  return steps.run("assign rate limit namespaces", async ({ log, orm }) => {
    const rows = await orm
      .select({
        binding: resources.binding,
        cfId: resources.cf_id,
        deletedAt: resources.deleted_at,
      })
      .from(resources)
      .where(and(eq(resources.install_id, installId), eq(resources.kind, RATE_LIMIT_KIND)));
    const ids: Record<string, string> = {};
    const at = new Date(steps.now());
    for (const name of names) {
      const row = rows.find((r) => r.binding === name && r.cfId !== null);
      if (row?.cfId != null && row.deletedAt === null) {
        ids[name] = row.cfId;
        continue;
      }
      const id = row?.cfId ?? randomNamespaceId();
      await orm
        .insert(resources)
        .values({
          id: resourceId(installId, RATE_LIMIT_KIND, name),
          install_id: installId,
          kind: RATE_LIMIT_KIND,
          binding: name,
          name,
          cf_id: id,
          created_at: at,
        })
        .onConflictDoUpdate({ target: resources.id, set: { cf_id: id, deleted_at: null } });
      ids[name] = id;
      log.info(`Rate limit ${name} counts in a namespace of its own (${id}).`);
    }
    return ids;
  });
}
