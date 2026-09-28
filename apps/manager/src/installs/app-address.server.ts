import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { resources } from "../db/schema";
import type { AddressDomain } from "./app-address";
import { ADDRESS_KINDS } from "./resource-kinds";
import { domainHostnames, primaryDomain, workersDevBase } from "./workers-dev";

/**
 * Where an install is reached now, for health checks and `{{appUrl}}`:
 * its workers.dev URL while that is on, else its primary custom or external
 * domain (see `primaryDomain`). Null when neither is known (workers.dev with
 * no known subdomain). The URL an "Open" button opens is `appAddress`.
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
      .select({
        id: resources.id,
        kind: resources.kind,
        name: resources.name,
        live_at: resources.live_at,
      })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, install.id),
          inArray(resources.kind, [...ADDRESS_KINDS]),
          isNull(resources.deleted_at),
        ),
      );
    const domain = primaryDomain(domainHostnames(rows), install.served_domain);
    if (domain !== null) return `https://${domain}`;
  }
  return subdomain ? workersDevBase(install.worker_name, subdomain) : null;
}

/** An address resource row as `appAddress` reads it. */
export function addressDomainOf(row: {
  id: string;
  kind: string;
  name: string;
  live_at: Date | null;
}): AddressDomain {
  return { id: row.id, kind: row.kind, name: row.name, live: row.live_at !== null };
}

/**
 * The custom and external domains of the given installs (every install when
 * `installIds` is omitted) that are not deleted or kept by an uninstall, by
 * install id, for `appAddress`.
 */
export async function readAddressDomains(
  db: Database,
  installIds?: readonly string[],
): Promise<Map<string, AddressDomain[]>> {
  const byInstall = new Map<string, AddressDomain[]>();
  if (installIds !== undefined && installIds.length === 0) return byInstall;
  const rows = await db
    .select({
      id: resources.id,
      installId: resources.install_id,
      kind: resources.kind,
      name: resources.name,
      live_at: resources.live_at,
    })
    .from(resources)
    .where(
      and(
        inArray(resources.kind, [...ADDRESS_KINDS]),
        isNull(resources.deleted_at),
        isNull(resources.retained_at),
        ...(installIds === undefined ? [] : [inArray(resources.install_id, [...installIds])]),
      ),
    );
  for (const row of rows) {
    byInstall.set(row.installId, [...(byInstall.get(row.installId) ?? []), addressDomainOf(row)]);
  }
  return byInstall;
}
