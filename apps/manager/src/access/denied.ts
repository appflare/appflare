/**
 * How the app recognises a request the Cloudflare Access check refused.
 * Client-safe: no server imports.
 *
 * Every refusal the check answers in JSON carries `code: "access_denied"`.
 * Refused server function calls are answered as `application/problem+json`:
 * TanStack Start's client returns a plain `application/json` body as the
 * call's result, but throws an `Error` whose message is the body for any
 * other type, so the route error screen can read the code from the message.
 */

export const ACCESS_DENIED_CODE = "access_denied";

/** Shown by the route error screen instead of the raw error. */
export const ACCESS_DENIED_MESSAGE =
  "Cloudflare Access refused this request. Sign in through Access and try again.";

/** The header TanStack Start's client sends with every server function call. */
export const SERVER_FN_HEADER = "x-tsr-serverfn";

/** True when `error` is a server function call the Access check refused. */
export function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const body: unknown = JSON.parse(error.message);
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { code?: unknown }).code === ACCESS_DENIED_CODE
    );
  } catch {
    return false;
  }
}
