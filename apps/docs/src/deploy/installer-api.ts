import { z } from "zod";

/**
 * The hosted installer's API at `/api/install/*`, on the page's own origin
 * (the site's Worker forwards it), so no request crosses origins. Each call
 * carries the access token, fetched (and renewed when needed) just before it
 * is sent. The refresh token is never sent here. Every answer is checked; an
 * error carries the installer's own message, which is written for the
 * person at the page.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const accountSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  name: z.string(),
  workersDevSubdomain: z.string().min(1).nullable(),
});
export type Account = z.infer<typeof accountSchema>;

const zoneSchema = z.object({ id: z.string(), name: z.string().min(1) });
export type Zone = z.infer<typeof zoneSchema>;

const conflictSchema = z.object({ conflict: z.string(), detail: z.string() });

const checkSchema = z.object({
  workerName: z.enum(["free", "taken"]),
  hostname: z.union([z.null(), z.literal("free"), conflictSchema]),
});
export type CheckResult = z.infer<typeof checkSchema>;

const releaseSchema = z.object({ release: z.object({ version: z.string().min(1) }) });

const createdSchema = z.object({
  installationId: z.string().regex(/^[0-9a-f-]{36}$/),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  release: z.object({ version: z.string().min(1) }),
  address: z.url({ protocol: /^https$/ }),
});
export type Created = z.infer<typeof createdSchema>;

const progressFields = {
  step: z.object({ id: z.string(), label: z.string() }),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  retryAfterMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
};

const stepSchema = z.object({
  status: z.enum(["running", "waiting", "deployed", "failed"]),
  ...progressFields,
  /** The step this answer finished, with what it said about it; `message` is about `step`. */
  completed: z
    .object({ step: z.object({ id: z.string(), label: z.string() }), message: z.string() })
    .optional(),
});
export type StepAnswer = z.infer<typeof stepSchema>;

const cleanupSchema = z.object({
  status: z.enum(["running", "waiting", "removed", "failed"]),
  ...progressFields,
});
export type CleanupAnswer = z.infer<typeof cleanupSchema>;

const unfinishedSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}$/),
  workerName: z.string(),
  hostname: z.string().nullable(),
  address: z.url({ protocol: /^https$/ }),
  status: z.string(),
  step: z.object({ id: z.string(), label: z.string() }),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  release: z.object({ version: z.string() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  message: z.string().optional(),
});
export type Unfinished = z.infer<typeof unfinishedSchema>;

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Codes this client gives failures that never got an answer from the installer. */
export const NETWORK_ERROR = "network";
export const INVALID_RESPONSE = "invalid_response";

export class InstallerApiError extends Error {
  override name = "InstallerApiError";
  constructor(
    /** Null when no answer arrived. */
    readonly status: number | null,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** The access token is gone or Cloudflare no longer accepts it: sign in again. */
  get needsAuthorization(): boolean {
    return this.status === 401;
  }

  /** Worth trying again shortly: no answer, a busy installer, or Cloudflare or GitHub busy. */
  get retryable(): boolean {
    return (
      this.status === null || this.status >= 500 || this.status === 429 || this.code === "busy"
    );
  }
}

export interface InstallerApi {
  accounts(): Promise<Account[]>;
  zones(accountId: string): Promise<Zone[]>;
  check(input: {
    accountId: string;
    workerName: string;
    hostname: string | null;
  }): Promise<CheckResult>;
  release(): Promise<{ version: string }>;
  create(input: {
    accountId: string;
    workerName: string;
    hostname: string | null;
    handoffHash: string;
  }): Promise<Created>;
  step(installationId: string, key: string): Promise<StepAnswer>;
  find(accountId: string): Promise<Unfinished[]>;
  /** With `key` null, the token's access to the account is the permission. */
  cleanup(installationId: string, key: string | null): Promise<CleanupAnswer>;
}

export interface InstallerApiOptions {
  fetch: FetchLike;
  /** The current access token, renewed first when it is about to expire. */
  accessToken: () => Promise<string>;
  /** Where the API is; the page's own origin by default. */
  base?: string;
}

const UNREACHABLE =
  "Appflare's installer did not answer. Check your connection; this page tries again.";
const UNREADABLE = "Appflare's installer gave an answer this page cannot read. Try again.";

function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

export function installerApi(options: InstallerApiOptions): InstallerApi {
  const base = options.base ?? "";

  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const token = await options.accessToken();
    let response: Response;
    try {
      response = await options.fetch(`${base}/api/install/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new InstallerApiError(null, NETWORK_ERROR, UNREACHABLE);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const failure = errorSchema.safeParse(json);
      if (failure.success) {
        throw new InstallerApiError(
          response.status,
          failure.data.error.code,
          failure.data.error.message,
          retryAfter(response),
        );
      }
      throw new InstallerApiError(
        response.status,
        INVALID_RESPONSE,
        response.status >= 500 ? UNREACHABLE : UNREADABLE,
        retryAfter(response),
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new InstallerApiError(response.status, INVALID_RESPONSE, UNREADABLE);
    return parsed.data;
  }

  return {
    async accounts() {
      return (await post("accounts", {}, z.object({ accounts: z.array(accountSchema) }))).accounts;
    },
    async zones(accountId) {
      return (await post("zones", { accountId }, z.object({ zones: z.array(zoneSchema) }))).zones;
    },
    check(input) {
      return post("check", input, checkSchema);
    },
    async release() {
      return (await post("release", {}, releaseSchema)).release;
    },
    create(input) {
      return post("installations", input, createdSchema);
    },
    step(installationId, key) {
      return post(`installations/${installationId}/step`, { key }, stepSchema);
    },
    async find(accountId) {
      const answer = await post(
        "installations/find",
        { accountId },
        z.object({ installations: z.array(unfinishedSchema) }),
      );
      return answer.installations;
    },
    cleanup(installationId, key) {
      return post(
        `installations/${installationId}/cleanup`,
        key === null ? {} : { key },
        cleanupSchema,
      );
    },
  };
}
