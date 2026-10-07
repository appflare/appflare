import { env } from "cloudflare:workers";
import type { SigningKey } from "@appflare/schema";
import { handleRequest } from "../api";
import { ensureMigrated } from "../db/migrate";
import { ReleaseCache } from "../release/cache";
import { ACCOUNT, type FakeWorld, TOKEN } from "./fake-world";

/** The handoff secret the deploy page made, and its sha256 the installer receives. */
export const HANDOFF_SECRET_VALUE = "the-handoff-secret-only-the-browser-knows";
export const HANDOFF_HASH = await sha256Hex(HANDOFF_SECRET_VALUE);

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function clearRecords(): Promise<void> {
  await ensureMigrated(env.DB);
  await env.DB.prepare("DELETE FROM installations").run();
}

export interface Answer<T = Record<string, unknown>> {
  status: number;
  body: T;
  text: string;
  /** Outgoing requests this one call made. */
  subrequests: number;
}

export interface AppOptions {
  env?: Partial<Env>;
  keys?: readonly SigningKey[];
  now?: () => number;
}

/** Calls the installer the way the docs Worker forwards a request to it. */
export function installerApp(world: FakeWorld, opts: AppOptions = {}) {
  const appEnv = { ...env, ...opts.env } as Env;
  // One per app, as one per isolate in production.
  const releaseCache = new ReleaseCache();
  return async function call<T = Record<string, unknown>>(
    path: string,
    body: unknown = {},
    init: { token?: string | null; method?: string } = {},
  ): Promise<Answer<T>> {
    const token = init.token === undefined ? TOKEN : init.token;
    const headers = new Headers({ "content-type": "application/json" });
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    const before = world.calls.length;
    const response = await handleRequest(
      new Request(`https://appflare.dev/api/install/${path}`, {
        method: init.method ?? "POST",
        headers,
        ...(init.method === "GET" ? {} : { body: JSON.stringify(body) }),
      }),
      appEnv,
      {
        fetch: world.fetch,
        keys: opts.keys ?? world.release.keys,
        releaseCache,
        ...(opts.now === undefined ? {} : { now: opts.now }),
      },
    );
    const text = await response.text();
    return {
      status: response.status,
      body: (text.length > 0 ? JSON.parse(text) : {}) as T,
      text,
      subrequests: world.calls.length - before,
    };
  };
}

export type Call = ReturnType<typeof installerApp>;

export interface Created {
  installationId: string;
  key: string;
  address: string;
  release: { version: string };
}

export async function createInstallation(
  call: Call,
  input: { workerName?: string; hostname?: string | null; accountId?: string } = {},
): Promise<Created> {
  const answer = await call<Created>("installations", {
    accountId: input.accountId ?? ACCOUNT,
    workerName: input.workerName ?? "appflare-probe",
    hostname: input.hostname ?? null,
    handoffHash: HANDOFF_HASH,
  });
  if (answer.status !== 200) throw new Error(`create answered ${answer.status}: ${answer.text}`);
  return answer.body;
}

export interface StepAnswer {
  status: "running" | "waiting" | "deployed" | "failed";
  step: { id: string; label: string };
  done: number;
  total: number;
  retryAfterMs?: number;
  message?: string;
  completed?: { step: { id: string; label: string }; message: string };
}

/** Calls `/step` until `until` holds for the answer (or `max` calls), checking every call's budget. */
export async function stepUntil(
  call: Call,
  created: Created,
  until: (answer: StepAnswer) => boolean,
  max = 40,
): Promise<{ answers: StepAnswer[]; last: StepAnswer }> {
  const answers: StepAnswer[] = [];
  for (let i = 0; i < max; i++) {
    const answer = await call<StepAnswer>(`installations/${created.installationId}/step`, {
      key: created.key,
    });
    if (answer.status !== 200) throw new Error(`step answered ${answer.status}: ${answer.text}`);
    if (answer.subrequests > 40) throw new Error(`a step made ${answer.subrequests} subrequests`);
    answers.push(answer.body);
    if (until(answer.body)) return { answers, last: answer.body };
  }
  throw new Error(`no matching answer after ${max} steps: ${JSON.stringify(answers.at(-1))}`);
}

export async function recordRow(id: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM installations WHERE id = ?1").bind(id).first();
}
