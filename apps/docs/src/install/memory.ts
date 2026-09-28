import { isAppflareOrigin } from "./address.ts";
import { type InstallRequest, isInstallRequest, sameRequest } from "./request.ts";

/**
 * What this browser remembers for the install pages, in `localStorage` and
 * nowhere else: the address of the visitor's Appflare, and, while they get
 * one, the app they were about to install (kept 7 days). Everything read
 * back is checked again, so a value someone else put there is ignored. A
 * browser that refuses storage (private windows in some browsers, blocked
 * site data) gets a memory that keeps nothing, and the pages ask for the
 * address each time.
 */

/** The part of `Storage` this needs; tests pass a plain object. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MANAGER_KEY = "appflare.manager";
export const INTENT_KEY = "appflare.intent";
const PROBE_KEY = "appflare.probe";

/** How long the app a visitor was about to install is kept while they get Appflare. */
export const INTENT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The app a visitor was about to install when they went to get Appflare. */
export type Intent = InstallRequest & { savedAt: string };

export interface Memory {
  /** False when this browser keeps nothing for the site. */
  readonly available: boolean;
  /** The remembered Appflare's address, or null. */
  manager(): string | null;
  /** Remembers an address; false when it is not one or nothing can be kept. */
  rememberManager(origin: string): boolean;
  forgetManager(): void;
  /** The saved intent while it is less than 7 days old; an older one is dropped. */
  intent(now: Date): Intent | null;
  saveIntent(request: InstallRequest, now: Date): boolean;
  /** Drops the saved intent if it is for `request`. */
  clearIntentFor(request: InstallRequest): void;
}

/** Runs a storage call, treating a refusal as "nothing there". */
function attempt<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/** A stored intent, whatever its age, or null when it is not one. */
function parseIntent(raw: string | null): Intent | null {
  if (raw === null) return null;
  const value = attempt<unknown>(() => JSON.parse(raw), null);
  if (!isInstallRequest(value)) return null;
  const savedAt = (value as { savedAt?: unknown }).savedAt;
  if (typeof savedAt !== "string" || Number.isNaN(Date.parse(savedAt))) return null;
  const request: InstallRequest =
    value.kind === "app" ? { kind: "app", slug: value.slug } : { kind: "repo", repo: value.repo };
  return { ...request, savedAt };
}

/** Whether an intent is still kept at `now`. A date in the future is as wrong as an old one. */
function isCurrent(intent: Intent, now: Date): boolean {
  const age = now.getTime() - Date.parse(intent.savedAt);
  return age >= -60_000 && age <= INTENT_LIFETIME_MS;
}

/**
 * The memory over `store`, which is fetched lazily because reading
 * `window.localStorage` itself throws where site data is blocked. A write
 * is tried once first: some browsers hand out a store that refuses every write.
 */
export function openMemory(store: () => KeyValueStore | null | undefined): Memory {
  const kv = attempt(() => {
    const s = store();
    if (s === null || s === undefined) return null;
    s.setItem(PROBE_KEY, "1");
    s.removeItem(PROBE_KEY);
    return s;
  }, null);
  if (kv === null) return blockedMemory;
  return {
    available: true,
    manager() {
      const value = attempt(() => kv.getItem(MANAGER_KEY), null);
      if (isAppflareOrigin(value)) return value;
      // Not an address this site would have kept: drop it rather than keep skipping it.
      if (value !== null) attempt(() => kv.removeItem(MANAGER_KEY), undefined);
      return null;
    },
    rememberManager(origin) {
      if (!isAppflareOrigin(origin)) return false;
      return attempt(() => {
        kv.setItem(MANAGER_KEY, origin);
        return true;
      }, false);
    },
    forgetManager() {
      attempt(() => kv.removeItem(MANAGER_KEY), undefined);
    },
    intent(now) {
      const raw = attempt(() => kv.getItem(INTENT_KEY), null);
      const intent = parseIntent(raw);
      if (intent !== null && isCurrent(intent, now)) return intent;
      if (raw !== null) attempt(() => kv.removeItem(INTENT_KEY), undefined);
      return null;
    },
    saveIntent(request, now) {
      if (!isInstallRequest(request)) return false;
      const intent: Intent = { ...request, savedAt: now.toISOString() };
      return attempt(() => {
        kv.setItem(INTENT_KEY, JSON.stringify(intent));
        return true;
      }, false);
    },
    clearIntentFor(request) {
      const saved = parseIntent(attempt(() => kv.getItem(INTENT_KEY), null));
      if (saved !== null && sameRequest(saved, request)) {
        attempt(() => kv.removeItem(INTENT_KEY), undefined);
      }
    },
  };
}

/** A memory that keeps nothing, for a browser that refuses storage. */
export const blockedMemory: Memory = {
  available: false,
  manager: () => null,
  rememberManager: () => false,
  forgetManager: () => {},
  intent: () => null,
  saveIntent: () => false,
  clearIntentFor: () => {},
};

/** This browser's memory: `localStorage`, or nothing where it is blocked. */
export function browserMemory(): Memory {
  return openMemory(() => (typeof window === "undefined" ? null : window.localStorage));
}
