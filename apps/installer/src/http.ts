import { z } from "zod";

/**
 * JSON in and out. Every error the API answers is `{ error: { code, message } }`
 * with a message written for the person at the deploy page, not for a
 * developer. Nothing here ever echoes a request header or body back.
 */

export class InstallerError extends Error {
  override name = "InstallerError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Sent as `Retry-After` (rounded up to seconds) when set. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function errorResponse(error: InstallerError): Response {
  const headers = new Headers(NO_STORE);
  if (error.retryAfterMs !== undefined) {
    headers.set("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers },
  );
}

/** Request bodies are small JSON objects; anything larger is refused unread. */
const MAX_BODY_BYTES = 16 * 1024;

export async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) {
    throw new InstallerError(413, "invalid_request", "The request is too large.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new InstallerError(413, "invalid_request", "The request is too large.");
  }
  let value: unknown;
  try {
    value = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new InstallerError(400, "invalid_request", "The request could not be read.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InstallerError(400, "invalid_request", requestProblem(parsed.error));
  }
  return parsed.data;
}

/** The first problem, by field name only: values are never repeated back. */
function requestProblem(error: z.ZodError): string {
  const field = error.issues[0]?.path.join(".");
  return field ? `The request has an invalid ${field}.` : "The request could not be read.";
}

/** Access tokens Cloudflare issues are printable ASCII without spaces. */
const BEARER = /^Bearer ([\x21-\x7e]{20,4096})$/;

/**
 * The access token from `Authorization: Bearer <token>`. It stays in the
 * request's memory: it is handed to the Cloudflare client and nowhere else.
 */
export function bearerToken(request: Request): string {
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  if (match?.[1] === undefined) {
    throw new InstallerError(
      401,
      "unauthorized",
      "Connect your Cloudflare account first, then try again.",
    );
  }
  return match[1];
}

export const accountIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "an account id");
export const installationIdSchema = z.string().regex(/^[0-9a-f-]{36}$/, "an installation id");
export const keySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "an installation key");
export const handoffHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "a sha256 hex digest");
