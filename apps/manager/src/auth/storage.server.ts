import {
  getCurrentAuthContextAsyncLocalStorage,
  getCurrentDBAdapterAsyncLocalStorage,
  getRequestStateAsyncLocalStorage,
} from "@better-auth/core/context";

/**
 * Better Auth keeps three `AsyncLocalStorage` instances per isolate (endpoint
 * context, request state, database adapter). It creates each on first use,
 * after awaiting one module-level `import("node:async_hooks")` promise that
 * it starts when its modules are first evaluated.
 *
 * On Workers, that evaluation happens inside whichever request first loads
 * the app's routes, which is often one that never touches auth (the health
 * check, the version shown in the footer). A dynamic import belongs to the
 * request that started it: if that request finishes, or its client goes
 * away, before the import settles, the promise stays pending for good, and
 * every later sign-in, session read or setup step in that isolate waits on it
 * forever with no error, until a new deployment replaces the isolate
 * (better-auth/better-auth#10315).
 *
 * So the first request an isolate serves creates all three storages itself,
 * before anything else runs, and keeps itself alive until they exist
 * (`waitUntil`, so a client that disconnects cannot cut it short). From then
 * on Better Auth finds them and never awaits that import again. Only success
 * is remembered: a failed attempt is retried by the next request.
 */

export interface AuthStorageDeps {
  /** Keeps the attempt alive past the response or a client disconnect (the request's `waitUntil`). */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Test seam: creates the storages (defaults to Better Auth's own getters). */
  create?: () => Promise<unknown>;
}

let ready = false;

function createAll(): Promise<unknown> {
  return Promise.all([
    getCurrentAuthContextAsyncLocalStorage(),
    getRequestStateAsyncLocalStorage(),
    getCurrentDBAdapterAsyncLocalStorage(),
  ]);
}

/** Resolves once Better Auth's storages exist in this isolate. Cheap after the first success. */
export async function ensureAuthStorage(deps: AuthStorageDeps): Promise<void> {
  if (ready) return;
  const attempt = (deps.create ?? createAll)();
  deps.waitUntil(attempt.catch(() => undefined));
  await attempt;
  ready = true;
}

/** Test-only: forget that the storages were created. */
export function resetAuthStorageForTests(): void {
  ready = false;
}
