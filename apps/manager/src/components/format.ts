/** Shared display formatting for dates, sizes, and labels. */

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const exactDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "long" });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : "Not yet";
}

/** The day only, for badges where the time would be noise. */
export function formatDate(iso: string): string {
  return date.format(new Date(iso));
}

/** Down to the second, with the time zone, for tooltips behind a shorter date. */
export function formatExactDateTime(iso: string): string {
  return exactDateTime.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

const bytesUnits = ["bytes", "KB", "MB", "GB", "TB"];

/** A byte count in decimal units, as the Cloudflare dashboard shows sizes. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < bytesUnits.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${bytesUnits[unit]}`;
}

/** `resources.kind` values as product names. */
export const RESOURCE_KIND_LABELS: Record<string, string> = {
  worker: "Worker",
  kv: "KV namespace",
  d1: "D1 database",
  r2: "R2 bucket",
  queue: "Queue",
  queue_consumer: "Queue consumer",
  vectorize: "Vectorize index",
  durable_object: "Durable Object class",
  workflow: "Workflow",
  cron: "Cron trigger",
  secret: "Secret",
  subdomain: "workers.dev route",
  ratelimit: "Rate limit",
  domain: "Custom domain",
};

export function resourceKindLabel(kind: string): string {
  return RESOURCE_KIND_LABELS[kind] ?? kind;
}

/** `jobs.kind` values as page titles; a database restore is recorded as a `rollback` job. */
export const JOB_KIND_LABELS: Record<string, string> = {
  install: "Install",
  update: "Update",
  uninstall: "Uninstall",
  rollback: "Rollback",
  self_update: "Appflare update",
};

export function jobKindLabel(kind: string, restore = false): string {
  if (restore) return "Database restore";
  return JOB_KIND_LABELS[kind] ?? kind;
}
