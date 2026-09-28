/**
 * The signed copy of the session Better Auth keeps in a cookie
 * (`session.cookieCache`), `<prefix>.session_data`, split into
 * `<prefix>.session_data.<n>` when it is long.
 */
export function isSessionCopyCookie(name: string): boolean {
  return /\.session_data(\.\d+)?$/.test(name);
}

/**
 * `request` without the session copy cookie, so Better Auth reads the
 * session from D1. Its own endpoints that act on the signed-in user
 * (passkeys, sessions) otherwise trust the copy; only `GET /get-session`,
 * which only reads, keeps it. The session token cookie stays.
 */
export function withoutSessionCopy(request: Request): Request {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return request;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !isSessionCopyCookie(part.slice(0, part.indexOf("=")).trim()));
  const rebuilt = kept.join("; ");
  if (rebuilt === cookie) return request;
  const headers = new Headers(request.headers);
  if (rebuilt === "") headers.delete("cookie");
  else headers.set("cookie", rebuilt);
  return new Request(request, { headers });
}

/** Whether Better Auth may answer `request` from the session copy: only a session read. */
export function mayUseSessionCopy(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname.endsWith("/get-session");
}
