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
 * Still needed with Better Auth 1.7.7: the issue is open and 1.7.7 still
 * starts that import when its modules are evaluated. Two fixes are proposed
 * and unreleased: #10318 takes `AsyncLocalStorage` from `globalThis` without
 * an import, and #11482 bounds and retries the cached initialization (and
 * leaves the import as it is). Remove this file once a release no longer
 * awaits a module-level `import("node:async_hooks")` in `@better-auth/core`'s
 * `async_hooks` module.
 *
 * So the first request an isolate serves creates all three storages itself,
 * before anything else runs, and keeps itself alive until they exist
 * (`waitUntil`, so a client that disconnects cannot cut it short). From then
 * on Better Auth finds them and never awaits that import again. Only success
 * is remembered: a failed attempt is retried by the next request.
 *
 * #11482 also describes a second hang: `betterAuth()` starts its own
 * initialization when it is built and keeps that promise for the life of the
 * instance, and the manager keeps one instance per isolate and origin
 * (server/auth.server.ts). That hang needs the initialization to wait on
 * something tied to the request that built the instance (a database query, a
 * fetch, a timer). With the manager's setup in Better Auth 1.7.7 it waits on
 * nothing: `better-auth/minimal` with an adapter function does no database
 * work, telemetry is off and has no endpoint, no plugin has an async `init`,
 * none of it awaits the import above, and the schema check it starts compares
 * the Drizzle schema object without reading D1. So the instance is ready
 * before the request that built it can end, and it needs no workaround
 * (`storage.server.test.ts` checks that it settles without waiting). Revisit
 * this if the auth setup gains a direct database, telemetry, or a plugin
 * whose `init` does I/O.
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
