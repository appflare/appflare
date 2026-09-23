/**
 * Post-install notes: markdown from the
 * signed catalog manifest with `{{workerUrl}}` and `{{workerName}}` filled in.
 * Unknown placeholders are left as written.
 */

export interface PostInstallValues {
  workerUrl: string | null;
  workerName: string;
}

export function workersDevUrl(
  workerName: string,
  subdomain: string | null | undefined,
): string | null {
  return subdomain ? `https://${workerName}.${subdomain}.workers.dev` : null;
}

export function renderPostInstall(content: string, values: PostInstallValues): string {
  return content.replace(/\{\{\s*(workerUrl|workerName)\s*\}\}/g, (match, key: string) => {
    if (key === "workerName") return values.workerName;
    return values.workerUrl ?? match;
  });
}
