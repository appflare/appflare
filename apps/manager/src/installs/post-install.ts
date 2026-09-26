import {
  type EntryWorkerPlaceholders,
  type PlaceholderValues,
  renderEntryWorkerPlaceholders,
  renderPlaceholders,
} from "@appflare/schema";

/**
 * Post-install notes: markdown from the
 * signed catalog manifest with `{{workerUrl}}`, `{{workerName}}` and
 * `{{accountId}}` filled in.
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

/**
 * `content` with the install's placeholders filled in, and for an app of
 * several Workers `{{workerUrl:<name>}}` and `{{workerName:<name>}}` too.
 */
export function renderPostInstall(
  content: string,
  values: PostInstallValues,
  entryWorkers?: EntryWorkerPlaceholders,
): string {
  const text = renderPlaceholders(content, values);
  return entryWorkers === undefined ? text : renderEntryWorkerPlaceholders(text, entryWorkers);
}
