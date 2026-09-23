import { WORKER_NAME_MAX_LENGTH, WORKER_NAME_PATTERN } from "./install-input";

/** Turns any string into something {@link WORKER_NAME_PATTERN} accepts. */
function normalizeWorkerName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WORKER_NAME_MAX_LENGTH)
    .replace(/-+$/, "");
  return cleaned.length > 0 ? cleaned : "app";
}

/**
 * The Worker name to prefill for a new install of an app: `base` when nobody
 * uses it, else the first free `base-2`, `base-3`, ... (the stem is shortened
 * when the suffix would make the name too long). `taken` holds the Worker
 * names of active installs and of any Worker already in the account.
 * Client-safe.
 */
export function suggestWorkerName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = normalizeWorkerName(base);
  if (!used.has(stem)) return stem;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const head = stem.slice(0, WORKER_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "");
    const candidate = `${head}${suffix}`;
    if (WORKER_NAME_PATTERN.test(candidate) && !used.has(candidate)) return candidate;
  }
  return stem;
}
