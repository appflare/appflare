import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { jobUnits, selfUnits } from "../jobs/units/client";
import { ensureOwner, isOwner } from "../server/users.server";
import { rotateAuthSecretCore } from "./auth-secret.server";
import { ROTATE_CONFIRMATION } from "./danger";
import { DangerError, OWNER_ONLY } from "./errors";
import {
  errorPage,
  PAGE_HEADERS,
  removalPageEnd,
  removalPageStart,
  removalStepLine,
  rotationPage,
} from "./pages";
import { deleteManagerWorker, type RemovalOutcome, runRemoval } from "./removal.server";
import { clearRemovalStarted, markRemovalStarted, removalInProgress } from "./removal-flag";
import {
  activeJobs,
  activeJobsMessage,
  externalDomainsInUse,
  externalDomainsMessage,
  findRemovalTargets,
} from "./removal-plan.server";

/**
 * The two danger-zone actions as HTTP endpoints. Settings posts a plain
 * HTML form to them, and each answers with a static page: the owner's
 * browser leaves the app for it, which matters most for the removal, whose
 * page must keep showing after the manager is gone. Both are owner only,
 * same-origin only, and take the typed confirmation from the form.
 */

/** How long the removal waits after its page was sent before the manager deletes itself. */
export const SELF_DELETE_DELAY_MS = 1500;

export interface DangerEnv {
  DB: D1Database;
  JOBS?: WorkflowLookup;
  SELF?: unknown;
  CF_API_TOKEN?: string;
  CF_API_BASE_URL?: string;
}

export interface DangerDeps {
  /** The signed-in user's id, or null. */
  userId: (request: Request) => Promise<string | null>;
  /** Keeps work alive after the response (the Worker's `waitUntil`). */
  waitUntil: (promise: Promise<unknown>) => void;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * A plain form post carries no CSRF token, so the request must prove it
 * comes from the manager's own pages: `Sec-Fetch-Site`, or else `Origin`.
 * (The session cookie is `SameSite=Lax` as well, so a cross-site post
 * arrives signed out.)
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: PAGE_HEADERS });
}

function refusal(title: string, error: unknown): Response {
  if (error instanceof DangerError) return page(errorPage(title, error.message), error.status);
  if (error instanceof CfTokenNotConfiguredError) return page(errorPage(title, error.message), 409);
  const message = error instanceof Error ? error.message : String(error);
  console.error("danger zone action failed", { error: message });
  return page(errorPage(title, `Cloudflare or the manager refused the request: ${message}`), 502);
}

/** Checks origin, session and ownership, and returns the typed confirmation. */
async function guard(request: Request, env: DangerEnv, deps: DangerDeps): Promise<string> {
  if (request.method !== "POST" || !isSameOrigin(request)) {
    throw new DangerError("This action only runs from Appflare's own Settings page.", 403);
  }
  const userId = await deps.userId(request);
  if (userId === null) throw new DangerError("Sign in as the owner, then try again.", 403);
  const orm = createDb(env.DB);
  await ensureOwner(orm);
  if (!(await isOwner(orm, userId))) throw new DangerError(OWNER_ONLY, 403);
  const form = await request.formData();
  const typed = form.get("confirm");
  return typeof typed === "string" ? typed.trim() : "";
}

function client(env: DangerEnv, deps: DangerDeps): Promise<CloudflareClient> {
  return getCfClient(env, deps.fetch === undefined ? {} : { fetch: deps.fetch });
}

/** `POST /api/danger/rotate-auth-secret` with `confirm=rotate`. */
export async function handleRotateAuthSecret(
  request: Request,
  env: DangerEnv,
  deps: DangerDeps,
): Promise<Response> {
  const title = "The auth secret was not rotated";
  try {
    const typed = await guard(request, env, deps);
    if (typed !== ROTATE_CONFIRMATION) {
      throw new DangerError(`Type "${ROTATE_CONFIRMATION}" to confirm. Nothing was changed.`);
    }
    await refuseDuringSelfUpdate(env.DB, env.JOBS, (m) => new DangerError(m, 409));
    const result = await rotateAuthSecretCore({
      db: env.DB,
      api: await client(env, deps),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    return page(rotationPage(result));
  } catch (error) {
    return refusal(title, error);
  }
}

/**
 * `POST /api/danger/remove-appflare` with `confirm=<account name>`. Checks
 * everything before it deletes anything and marks the removal as started
 * (no job starts from then on), then answers with a page that shows each
 * step as it finishes. Once the D1 database is gone the manager Worker
 * deletes itself, after the page is complete, or right away if the browser
 * went away. When the removal stops earlier, the mark is cleared and the
 * manager keeps working.
 */
export async function handleRemoveAppflare(
  request: Request,
  env: DangerEnv,
  deps: DangerDeps,
): Promise<Response> {
  const title = "Appflare was not removed";
  let api: CloudflareClient;
  let targets: Awaited<ReturnType<typeof findRemovalTargets>>;
  try {
    const typed = await guard(request, env, deps);
    api = await client(env, deps);
    targets = await findRemovalTargets(env.DB, api);
    if (typed !== targets.accountName.trim()) {
      throw new DangerError(
        `Type the Cloudflare account name, ${targets.accountName}, to confirm. Nothing was deleted.`,
      );
    }
    const external = await externalDomainsInUse(env.DB);
    if (external.length > 0) throw new DangerError(externalDomainsMessage(external), 409);
    if ((await removalInProgress(env.DB)) !== null) {
      throw new DangerError(
        "A removal of Appflare is already running. Wait for its page to finish.",
        409,
      );
    }
    // Marked before the job check: a job start that raced it loses its claim.
    await markRemovalStarted(env.DB, new Date());
    const active = await activeJobs(env.DB, env.JOBS);
    if (active.length > 0) {
      await clearRemovalStarted(env.DB);
      throw new DangerError(activeJobsMessage(active), 409);
    }
  } catch (error) {
    return refusal(title, error);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (html: string) => writer.write(encoder.encode(html));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const units = jobUnits(
    { SELF: selfUnits(env), CF_API_TOKEN: env.CF_API_TOKEN, CF_API_BASE_URL: env.CF_API_BASE_URL },
    deps.fetch === undefined ? {} : { fetch: deps.fetch },
  );

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const run = async () => {
    let outcome: RemovalOutcome;
    try {
      await write(
        removalPageStart({
          accountName: targets.accountName,
          workerName: targets.manager.workerName,
        }),
      );
      outcome = await runRemoval({
        db: env.DB,
        api,
        units,
        targets,
        emit: (step) => write(removalStepLine(step)),
        sleep,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
    } catch (error) {
      // The first write failed (the browser went away at once) or something
      // unexpected was thrown before the D1 database was deleted.
      console.error("removal stopped", { error: errorText(error) });
      outcome = { kind: "page-lost" };
    }

    if (outcome.kind !== "complete") {
      // The manager keeps working: jobs may start again, and the removal can be run again.
      await clearRemovalStarted(env.DB).catch((error: unknown) =>
        console.error("removal: could not clear its mark", { error: errorText(error) }),
      );
    }
    if (outcome.kind !== "page-lost") {
      try {
        await write(
          removalPageEnd({
            outcome: outcome.kind,
            accountId: targets.accountId,
            workerName: targets.manager.workerName,
            containersLeft:
              targets.sandbox.worker === "sandbox" && targets.sandbox.containerApps === null,
            accessOn: targets.accessAppIds.length > 0,
            accessLeft: outcome.kind === "complete" ? outcome.accessLeft : [],
          }),
        );
        await writer.close();
      } catch (error) {
        console.error("removal: the final page could not be written", { error: errorText(error) });
      }
    }
    if (outcome.kind === "page-lost") await writer.abort().catch(() => {});
    if (outcome.kind !== "complete") return;
    // The D1 database is gone: the manager Worker goes too, after its page
    // (or right away when the browser is no longer reading it).
    await sleep(SELF_DELETE_DELAY_MS);
    if (await deleteManagerWorker(api, targets.manager)) {
      console.log(`removal: deleted the Worker ${targets.manager.workerName}`);
    }
  };
  deps.waitUntil(run());
  return new Response(readable, { headers: PAGE_HEADERS });
}
