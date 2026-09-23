/** Shared display formatting for dates, sizes, and labels. */

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : "Not yet";
}

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

/** Catalog `requires` values as product names. */
export const REQUIREMENT_LABELS: Record<string, string> = {
  r2: "R2",
  zone: "A zone on this account",
  "email-routing": "Email Routing",
  "workers-ai": "Workers AI",
  "browser-rendering": "Browser Rendering",
  containers: "Containers",
};

export function requirementLabel(value: string): string {
  return REQUIREMENT_LABELS[value] ?? value;
}

/** `resources.kind` values as product names. */
export const RESOURCE_KIND_LABELS: Record<string, string> = {
  worker: "Worker",
  kv: "KV namespace",
  d1: "D1 database",
  r2: "R2 bucket",
  queue: "Queue",
  vectorize: "Vectorize index",
  durable_object: "Durable Object class",
  workflow: "Workflow",
  cron: "Cron trigger",
  secret: "Secret",
  subdomain: "workers.dev route",
};

export function resourceKindLabel(kind: string): string {
  return RESOURCE_KIND_LABELS[kind] ?? kind;
}
