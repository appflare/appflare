import { type PlaceholderValues, renderPlaceholders } from "@appflare/schema";

/**
 * Post-install notes: markdown from the
 * signed catalog manifest with `{{workerUrl}}` and `{{workerName}}` filled in.
 * Unknown placeholders are left as written. Vars take the same placeholders
 * (install-vars.ts).
 */

export type PostInstallValues = PlaceholderValues;

export function workersDevUrl(
  workerName: string,
  subdomain: string | null | undefined,
): string | null {
  return subdomain ? `https://${workerName}.${subdomain}.workers.dev` : null;
}

export function renderPostInstall(content: string, values: PostInstallValues): string {
  return renderPlaceholders(content, values);
}
