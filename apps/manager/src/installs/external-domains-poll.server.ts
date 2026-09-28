import type { CloudflareClient, CustomHostname } from "@appflare/cf-api";
import { appRefOf, type InstallRow, readMessageLabels } from "../notifications/events.server";
import { emitEvent, readChannels } from "../notifications/outbox.server";
import { parseExternalDomainRef } from "./external-domains.server";
import {
  domainStateChange,
  observedDomainState,
  parseRecordedDomainState,
  type RecordedDomainState,
  recordedDomainStateJson,
} from "./external-domains-poll";
import { CUSTOM_HOSTNAME_KIND } from "./resource-kinds";

/**
 * The scheduled check of external domains. The app page reads a domain's
 * state only while it is open, and the install job waits for it only a few
 * minutes, so the cron checks every external domain: one list of custom
 * hostnames per zone the domains are on (in practice the gateway zone), at 50
 * per page. The list holds every hostname of the zone, so active domains are
 * checked from the same answer as pending ones. It records each domain's
 * state and, when a domain goes active, fails, or is removed at Cloudflare
 * (deleted in the dashboard), emits "Domain active" or "Domain failed" once
 * per change (./external-domains-poll.ts decides both). Without external
 * domains it makes no Cloudflare call at all.
 *
 * States are `settings` rows `external_domain_state:<resource id>`, removed
 * once the domain is. Runs as the `checkExternalDomains` notification unit,
 * in an invocation of its own when the manager has its `SELF` binding, since
 * a zone with many custom hostnames takes a request per page.
 */

export const DOMAIN_STATE_PREFIX = "external_domain_state:";

export interface PolledDomain {
  resourceId: string;
  hostname: string;
  zoneId: string;
  customHostnameId: string;
  /** When the install claimed the name (epoch ms). */
  addedAt: number;
  install: InstallRow;
}

export interface DomainCheckPlan {
  domains: PolledDomain[];
  recorded: Map<string, RecordedDomainState>;
  /** There are external domains, so Cloudflare is asked. */
  needed: boolean;
}

/**
 * The external domains of installs that are not being removed, with
 * Cloudflare's ids, and their recorded states. Deletes the recorded state of
 * a domain that is gone.
 */
export async function planDomainCheck(db: D1Database): Promise<DomainCheckPlan> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS resource_id, r.name AS hostname, r.cf_id, r.created_at AS added_at,
              i.id, i.app_slug, i.worker_name, i.display_name, i.catalog_version, i.manifest_json
       FROM resources r JOIN installs i ON i.id = r.install_id
       WHERE r.kind = ?1 AND r.deleted_at IS NULL AND r.retained_at IS NULL
         AND r.cf_id IS NOT NULL AND i.status NOT IN ('uninstalling', 'uninstalled')
       ORDER BY r.rowid`,
    )
    .bind(CUSTOM_HOSTNAME_KIND)
    .all<InstallRow & { resource_id: string; hostname: string; cf_id: string; added_at: number }>();
  const domains: PolledDomain[] = [];
  for (const row of results) {
    const ref = parseExternalDomainRef(row.cf_id);
    if (ref === null) continue;
    domains.push({
      resourceId: row.resource_id,
      hostname: row.hostname,
      zoneId: ref.zoneId,
      customHostnameId: ref.customHostnameId,
      addedAt: row.added_at,
      install: {
        id: row.id,
        app_slug: row.app_slug,
        worker_name: row.worker_name,
        display_name: row.display_name,
        catalog_version: row.catalog_version,
        manifest_json: row.manifest_json,
      },
    });
  }
  const { results: rows } = await db
    .prepare("SELECT key, value FROM settings WHERE key LIKE ?1")
    .bind(`${DOMAIN_STATE_PREFIX}%`)
    .all<{ key: string; value: string }>();
  const live = new Set(domains.map((d) => d.resourceId));
  const recorded = new Map<string, RecordedDomainState>();
  const gone: string[] = [];
  for (const row of rows) {
    const id = row.key.slice(DOMAIN_STATE_PREFIX.length);
    if (!live.has(id)) {
      gone.push(row.key);
      continue;
    }
    const state = parseRecordedDomainState(row.value);
    if (state !== null) recorded.set(id, state);
  }
  if (gone.length > 0) {
    await db.batch(gone.map((key) => db.prepare("DELETE FROM settings WHERE key = ?1").bind(key)));
  }
  return {
    domains,
    recorded,
    needed: domains.length > 0,
  };
}

export interface DomainCheckReport {
  /** External domains checked. */
  checked: number;
  /** Zones whose custom hostnames were listed. */
  zones: number;
  /** Zones whose list failed (the domains on them keep their recorded state). */
  unreadZones: number;
  activated: number;
  failed: number;
  /** Deliveries queued for the events. */
  queued: number;
}

async function stillRecorded(db: D1Database, resourceId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS live FROM resources WHERE id = ?1 AND deleted_at IS NULL")
    .bind(resourceId)
    .first<{ live: number }>();
  return row !== null;
}

/** Checks every external domain; see the module comment. */
export async function checkExternalDomains(deps: {
  db: D1Database;
  /** The client, or how to make it (only once Cloudflare is to be asked). */
  api: CloudflareClient | (() => Promise<CloudflareClient>);
  now?: () => number;
}): Promise<DomainCheckReport> {
  const now = (deps.now ?? Date.now)();
  const report: DomainCheckReport = {
    checked: 0,
    zones: 0,
    unreadZones: 0,
    activated: 0,
    failed: 0,
    queued: 0,
  };
  const plan = await planDomainCheck(deps.db);
  if (!plan.needed) return report;
  const api = typeof deps.api === "function" ? await deps.api() : deps.api;
  const byZone = new Map<string, PolledDomain[]>();
  for (const domain of plan.domains) {
    byZone.set(domain.zoneId, [...(byZone.get(domain.zoneId) ?? []), domain]);
  }
  const channels = await readChannels(deps.db);
  // What messages call the installs, read only once a domain changed.
  let labels: Map<string, string> | undefined;
  const labelsOf = async () => {
    labels ??= await readMessageLabels(
      deps.db,
      plan.domains.map((d) => d.install),
    );
    return labels;
  };
  const writes: D1PreparedStatement[] = [];
  for (const [zoneId, domains] of byZone) {
    let listed: CustomHostname[];
    try {
      listed = await api.customHostnames.list(zoneId);
    } catch (error) {
      // Cloudflare for SaaS turned off, a token without SSL and Certificates,
      // an outage: nothing is known, so nothing changes.
      console.warn("external domain check: listing custom hostnames failed", {
        zoneId,
        error: error instanceof Error ? error.message : String(error),
      });
      report.unreadZones++;
      continue;
    }
    report.zones++;
    const byId = new Map(listed.map((ch) => [ch.id, ch]));
    for (const domain of domains) {
      const ch = byId.get(domain.customHostnameId);
      // Removing a domain deletes its custom hostname before its row: one
      // removed during this check is gone, not failed.
      if (ch === undefined && !(await stillRecorded(deps.db, domain.resourceId))) continue;
      report.checked++;
      const observed = observedDomainState(ch);
      const change = domainStateChange(
        plan.recorded.get(domain.resourceId) ?? null,
        observed.state,
        { now, addedAt: domain.addedAt },
      );
      if (change.event !== null) {
        const app = appRefOf(domain.install, await labelsOf());
        const facts =
          change.event === "domain_active"
            ? { type: "domain_active" as const, app, hostname: domain.hostname }
            : {
                type: "domain_failed" as const,
                app,
                hostname: domain.hostname,
                reason: observed.reason ?? "",
              };
        const out = await emitEvent(
          deps.db,
          channels,
          {
            type: change.event,
            dedupeKey: `${change.event}:${domain.resourceId}:${change.from}`,
            facts,
            occurredAt: now,
          },
          now,
        );
        report.queued += out.queued;
        if (change.event === "domain_active") report.activated++;
        else report.failed++;
      }
      if (change.record !== null) {
        writes.push(
          deps.db
            .prepare(
              `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .bind(
              `${DOMAIN_STATE_PREFIX}${domain.resourceId}`,
              recordedDomainStateJson(change.record),
              now,
            ),
        );
      }
    }
  }
  if (writes.length > 0) await deps.db.batch(writes);
  return report;
}
