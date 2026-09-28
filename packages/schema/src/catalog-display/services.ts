import { requirementService, type ServiceId } from "../services";

/**
 * "What it needs on your account" on an app's page: the Cloudflare services
 * the app uses, in plain names, and whether the app says it needs each one
 * or the catalog worked it out from what the app binds.
 */

/** Plain names for what an app uses; the product name stays where people know it by it. */
export const SERVICE_NAMES: Record<ServiceId, string> = {
  kv: "KV storage",
  d1: "D1 database",
  r2: "R2 storage",
  "durable-objects": "Durable Objects",
  hyperdrive: "Your own database",
  vectorize: "Vector search",
  "analytics-engine": "Analytics Engine",
  queues: "Queues",
  pipelines: "Pipelines",
  workflows: "Workflows",
  cron: "Runs on a schedule",
  "workers-ai": "Workers AI",
  "browser-rendering": "Browser Rendering",
  images: "Cloudflare Images",
  containers: "Containers",
  "email-routing": "Email Routing",
  zone: "A domain",
  access: "Cloudflare Access",
};

/** The plain name of a service id, or null for one this version does not know. */
export function serviceName(id: string): string | null {
  return Object.hasOwn(SERVICE_NAMES, id) ? SERVICE_NAMES[id as ServiceId] : null;
}

/**
 * How a page says why an app counts a service: "This app needs it" when the
 * app's `requires` names it, "This app uses it" when it was worked out from
 * the app's bindings or its token's permissions (which does not gate an
 * install).
 */
export function serviceNeedWords(declared: boolean): "This app needs it" | "This app uses it" {
  return declared ? "This app needs it" : "This app uses it";
}

/** The services an app's `requires` names, for {@link serviceNeedWords}. */
export function declaredServices(requires: readonly string[]): Set<ServiceId> {
  const declared = new Set<ServiceId>();
  for (const requirement of requires) {
    const id = requirementService(requirement);
    if (id !== null) declared.add(id);
  }
  return declared;
}
