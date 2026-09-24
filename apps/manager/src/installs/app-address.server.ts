import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { resources } from "../db/schema";
import { CUSTOM_DOMAIN_KIND } from "./resource-kinds";
import { domainHostnames, primaryDomain, workersDevBase } from "./workers-dev";

/**
 * Where an install is reached now: its workers.dev URL while that is on,
 * else its primary custom domain (see `primaryDomain`). Null when neither is
 * known (workers.dev with no known subdomain).
 */
export async function readAppBaseUrl(
  db: Database,
  install: {
    id: string;
    worker_name: string;
    workers_dev_enabled: boolean;
    served_domain: string | null;
  },
  subdomain: string | null | undefined,
): Promise<string | null> {
  if (!install.workers_dev_enabled) {
    const rows = await db
      .select({ id: resources.id, kind: resources.kind, name: resources.name })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, install.id),
          eq(resources.kind, CUSTOM_DOMAIN_KIND),
          isNull(resources.deleted_at),
        ),
      );
    const domain = primaryDomain(domainHostnames(rows), install.served_domain);
    if (domain !== null) return `https://${domain}`;
  }
  return subdomain ? workersDevBase(install.worker_name, subdomain) : null;
}
