/**
 * Anonymous usage data, shared by the manager Worker and the CLI.
 *
 * Both send PostHog "anonymous events" to PostHog Cloud's EU region through
 * its `/batch/` capture endpoint (posthog.com/docs/api/capture). The project
 * token below is PostHog's public ingestion key: it can only add events and
 * never reads anything back, so it is safe to publish. Every event is tied to
 * a random install id, never to a person (`$process_person_profile: false`),
 * and carries only enums, counts, booleans, versions and durations.
 */

import { SITE_URL } from "./links";

/** PostHog Cloud EU ingestion host. */
export const TELEMETRY_HOST = "https://eu.i.posthog.com";

/** The batch capture endpoint (one request for any number of events). */
export const TELEMETRY_BATCH_URL = `${TELEMETRY_HOST}/batch/`;

/** The public PostHog project token (ingestion only). */
export const TELEMETRY_PROJECT_KEY = "phc_ALESBsbeNDUPHQQN3KNbEYTrFJwBmJvqh28BGDXF9PUs";

/** What is sent and how to turn it off. */
export const TELEMETRY_DOCS_URL = `${SITE_URL}/telemetry/`;

/**
 * The manager Worker variable (and CLI environment variable) that turns
 * usage data off: `off`, `0` or `false`. On the manager it is a lock that
 * Settings cannot override.
 */
export const TELEMETRY_VAR = "APPFLARE_TELEMETRY";

/** The widely used opt-out variable; `1` or `true` turns usage data off too. */
export const DO_NOT_TRACK_VAR = "DO_NOT_TRACK";

/**
 * The plain-text variable the CLI deploys the manager with: the install id the
 * CLI used for its own events, so the manager continues it.
 */
export const INSTALL_ID_VAR = "APPFLARE_INSTALL_ID";

/** Which variable turned usage data off, or null when none did. */
export type TelemetryLock = typeof TELEMETRY_VAR | typeof DO_NOT_TRACK_VAR;

export function telemetryLock(vars: {
  APPFLARE_TELEMETRY?: string | undefined;
  DO_NOT_TRACK?: string | undefined;
}): TelemetryLock | null {
  const setting = vars.APPFLARE_TELEMETRY?.trim().toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false") return TELEMETRY_VAR;
  const dnt = vars.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt === "1" || dnt === "true") return DO_NOT_TRACK_VAR;
  return null;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `value` is a random (v4) UUID, the only shape an install id takes. */
export function isInstallId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/** A property value: only enums, counts, booleans, versions, durations, and lists or maps of them. */
export type TelemetryValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | { readonly [key: string]: number };

export interface TelemetryEvent {
  event: string;
  /** ISO 8601. */
  timestamp: string;
  /** Deterministic where a retry could resend the event, so PostHog drops the copy. */
  uuid: string;
  properties: Record<string, TelemetryValue>;
}

/** Where an event comes from; `$lib` and `source` on every event. */
export type TelemetrySource = "manager" | "cli";

/**
 * The properties every event carries: anonymous (no person profile), no
 * GeoIP enrichment, and the sender.
 */
export function commonTelemetryProperties(
  source: TelemetrySource,
  managerVersion: string | null,
): Record<string, TelemetryValue> {
  return {
    $process_person_profile: false,
    $geoip_disable: true,
    $lib: `appflare-${source}`,
    source,
    manager_version: managerVersion,
  };
}

/** The `/batch/` request body for events of one install id. */
export function telemetryBatchBody(
  installId: string,
  events: readonly TelemetryEvent[],
): { api_key: string; historical_migration: false; batch: unknown[] } {
  return {
    api_key: TELEMETRY_PROJECT_KEY,
    historical_migration: false,
    batch: events.map((e) => ({
      event: e.event,
      uuid: e.uuid,
      timestamp: e.timestamp,
      distinct_id: installId,
      properties: { ...e.properties, distinct_id: installId },
    })),
  };
}
