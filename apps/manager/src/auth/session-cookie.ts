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

/**
 * `headers` with its `Cookie` header as a browser would send it after the
 * given `Set-Cookie` headers: each one replaces the cookie of that name, and
 * an expired one (`Max-Age=0`) removes it. For reading a session within the
 * request that just opened it.
 */
export function withSetCookies(headers: Headers, setCookies: readonly string[]): Headers {
  if (setCookies.length === 0) return headers;
  const jar = new Map<string, string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  for (const line of setCookies) {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    if (/;\s*max-age=0\s*(;|$)/i.test(line)) jar.delete(name);
    else jar.set(name, pair.slice(at + 1).trim());
  }
  const next = new Headers(headers);
  if (jar.size === 0) next.delete("cookie");
  else next.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  return next;
}
