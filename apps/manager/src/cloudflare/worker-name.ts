/**
 * How the manager finds its own Worker name: the runtime does not
 * expose it, so it is inferred from the request URL and confirmed against the
 * account's script list, then cached in `settings.worker_name`.
 */

/** The name `create-appflare` deploys the manager under. */
export const DEFAULT_WORKER_NAME = "appflare";

const WORKERS_DEV_SUFFIX = ".workers.dev";

/**
 * `<script>.<subdomain>.workers.dev` -> `<script>`; any other host -> null. On a
 * preview host this is the whole first label (`<version>-<script>` or
 * `<alias>-<script>`); {@link workerNameCandidates} strips the prefix.
 */
export function workerNameFromHost(host: string): string | null {
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  if (!hostname.endsWith(WORKERS_DEV_SUFFIX)) return null;
  const labels = hostname.split(".");
  // At least <script>.<subdomain>.workers.dev.
  if (labels.length < 4) return null;
  return labels[0] || null;
}

/**
 * Possible script names in a workers.dev first label, longest first: the label
 * itself, then every suffix after a `-`. Version preview hosts are
 * `<8 hex>-<script>` and alias preview hosts `<alias>-<script>`; aliases and
 * script names may both contain dashes, so every split is a candidate and the
 * script list decides.
 */
export function workerNameCandidates(host: string): string[] {
  const label = workerNameFromHost(host);
  if (label === null) return [];
  const candidates = [label];
  for (let i = label.indexOf("-"); i !== -1; i = label.indexOf("-", i + 1)) {
    const rest = label.slice(i + 1);
    if (rest.length > 0) candidates.push(rest);
  }
  return candidates;
}

/** `<script>.<subdomain>.workers.dev` -> `<subdomain>`; any other host -> null. */
export function workersDevSubdomainFromHost(host: string): string | null {
  if (workerNameFromHost(host) === null) return null;
  const labels = host.toLowerCase().replace(/:\d+$/, "").split(".");
  return labels[labels.length - 3] ?? null;
}

export type WorkerNameDiscovery =
  | { ok: true; workerName: string; source: "host" | "default" }
  | { ok: false; error: string };

/**
 * Prefers the workers.dev host label when that script exists, else a script named
 * `appflare`, else fails: saving the token onto the wrong Worker must never happen
 * by guesswork.
 */
export function discoverWorkerName(
  host: string,
  scripts: ReadonlyArray<{ id: string }>,
): WorkerNameDiscovery {
  const names = new Set(scripts.map((s) => s.id));
  const fromHost = workerNameCandidates(host).find((name) => names.has(name));
  if (fromHost !== undefined) return { ok: true, workerName: fromHost, source: "host" };
  if (names.has(DEFAULT_WORKER_NAME)) {
    return { ok: true, workerName: DEFAULT_WORKER_NAME, source: "default" };
  }
  const label = workerNameFromHost(host);
  const tried =
    label !== null && label !== DEFAULT_WORKER_NAME
      ? `"${label}" or "${DEFAULT_WORKER_NAME}"`
      : `"${DEFAULT_WORKER_NAME}"`;
  return {
    ok: false,
    error: `Appflare could not find its own Worker in this account (looked for ${tried}). Make sure the token is for the account Appflare is installed in.`,
  };
}

/**
 * Whether `host` is a version preview of the Worker
 * (`<first 8 hex of the version id>-<worker>.<subdomain>.workers.dev`). With
 * the Worker name unknown, any `<8 hex>-` first label counts.
 */
export function isVersionPreviewHost(host: string, workerName: string | null): boolean {
  const label = workerNameFromHost(host);
  if (label === null) return false;
  const m = /^[0-9a-f]{8}-(.+)$/.exec(label);
  if (m === null) return false;
  return workerName === null || m[1] === workerName.toLowerCase();
}
