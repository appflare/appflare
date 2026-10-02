import type { AccessDestination, CloudflareClient } from "@appflare/cf-api";
import { z } from "zod";
import type { BypassOutcome } from "../../access/bypass.server";
import {
  type RemovalRelease,
  releaseAppAccessForRemoval,
} from "../../access/install-access.server";
import {
  type ProtectOutcome,
  protectInstall,
  type SyncOutcome,
  syncInstallAccessDestinations,
  unprotectInstall,
} from "../../access/protect.server";
import { ACCESS_MESSAGES, AccessToggleError } from "../../access/toggle.server";
import { JobError } from "../errors";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "./result";

/**
 * The job units that change an install's Cloudflare Access protection
 * (access/protect.server.ts), each in an invocation of its own over `SELF`,
 * so the job pays one subrequest per call whatever the call makes:
 *
 * - `protectInstall`: the install's Worker names, the account's
 *   subdomain (from settings), the organization, the list of Access
 *   applications, "Appflare users" (a write, and a list when it must be
 *   found), the install's token (a list, and a create), then the
 *   application's create or rewrite: about 7 requests, 10 at most.
 * - `syncInstallAccess`: nothing when the destinations did not change, else
 *   a read and a rewrite of the application (and a script list when a
 *   Worker's tag is not recorded); then, for an app with public paths, a
 *   read and maybe a rewrite of their application.
 * - `unprotectInstall`: the public paths' application (a delete, and a list
 *   when it was not recorded), the application (a delete), the token (a
 *   delete) and "Appflare users" when no app uses it (a list and a delete):
 *   6 requests at most.
 * - `releaseAppAccess`: for "Remove Appflare", up to
 *   {@link RELEASES_PER_CALL} installs, each a read and a rewrite of its
 *   application and the deletion of its token.
 *
 * They read the manager's D1 and `BETTER_AUTH_SECRET` from the Worker's own
 * environment. A refusal (a missing permission, no Zero Trust organization,
 * another application on the app's address) ends the step without retries;
 * another Access change holding the lock is retried.
 */

/** Installs one `releaseAppAccess` call releases: 3 requests each, well inside a unit's 50. */
export const RELEASES_PER_CALL = 10;

const workerSchema = z.object({
  name: z.string().min(1).max(100),
  /** Null: not uploaded yet (its future workers.dev hostname is covered). Absent: looked up. */
  tag: z.string().min(1).max(200).nullable().optional(),
});

export const protectInstallInputSchema = z.object({
  accountId: z.string().min(1),
  installId: z.string().min(1),
  workers: z.array(workerSchema).min(1).max(20).optional(),
  appName: z.string().min(1).max(200).optional(),
  pendingExternalHosts: z.array(z.string().min(1).max(300)).max(10).optional(),
  /** The public paths the admin accepts by protecting it (`ProtectRequest.acceptPaths`). */
  acceptPaths: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type ProtectInstallInput = z.infer<typeof protectInstallInputSchema>;

export interface ProtectInstallUnitResult {
  outcome: ProtectOutcome;
  accessAppId: string;
  appName: string;
  aud: string;
  teamDomain: string;
  /** What the application covers, for the job's log. */
  covers: string[];
  /** What happened to the app's public paths; absent from a unit of an earlier version. */
  bypass?: { outcome: BypassOutcome; uris: string[] } | null;
  /** Why the public paths could not be brought in step (they stay protected). */
  bypassProblem?: string | null;
}

export const unprotectInstallInputSchema = z.object({
  accountId: z.string().min(1),
  installId: z.string().min(1),
});
export type UnprotectInstallInput = z.infer<typeof unprotectInstallInputSchema>;

export interface UnprotectInstallResult {
  /** Whether there was protection to take off. */
  removed: boolean;
}

export const syncInstallAccessInputSchema = z.object({
  accountId: z.string().min(1),
  installId: z.string().min(1),
  pendingExternalHosts: z.array(z.string().min(1).max(300)).max(10).optional(),
  /**
   * The public paths a version about to serve shares with the serving one,
   * so paths it drops stop being public before it serves (bypass.server.ts).
   * Absent: the paths of the recorded manifest.
   */
  bypassPaths: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type SyncInstallAccessInput = z.infer<typeof syncInstallAccessInputSchema>;

export interface SyncInstallAccessResult {
  outcome: SyncOutcome;
}

export const releaseAppAccessInputSchema = z.object({
  accountId: z.string().min(1),
  installIds: z.array(z.string().min(1)).min(1).max(RELEASES_PER_CALL),
});
export type ReleaseAppAccessInput = z.infer<typeof releaseAppAccessInputSchema>;

/** A destination as the log names it. */
export function describeDestination(d: AccessDestination): string {
  return d.type === "worker" ? `the Worker with tag ${d.worker_id}` : d.uri;
}

/** An Access refusal becomes final; another change holding the lock is retried. */
function asStepError(error: unknown): unknown {
  if (error instanceof AccessToggleError) {
    return error.message === ACCESS_MESSAGES.busy
      ? new Error(error.message)
      : new JobError(error.message);
  }
  return error;
}

/** What the Access functions need, from the Worker's own environment. */
function accessDeps(env: UnitEnv, deps: UnitDeps, cf: () => CloudflareClient) {
  if (env.DB === undefined) throw new JobError("this Worker has no D1 binding for Access changes");
  const now = deps.now;
  return {
    db: env.DB,
    client: cf(),
    authSecret: env.BETTER_AUTH_SECRET,
    ...(now === undefined ? {} : { now: () => new Date(now()) }),
  };
}

export function runProtectInstall(
  env: UnitEnv,
  deps: UnitDeps,
  input: ProtectInstallInput,
): Promise<UnitResult<ProtectInstallUnitResult>> {
  return runUnit(env, deps, input.accountId, async ({ log, cf }) => {
    try {
      const result = await protectInstall(accessDeps(env, deps, cf), {
        installId: input.installId,
        ...(input.workers === undefined ? {} : { workers: input.workers }),
        ...(input.appName === undefined ? {} : { appName: input.appName }),
        ...(input.pendingExternalHosts === undefined
          ? {}
          : { pendingExternalHosts: input.pendingExternalHosts }),
        ...(input.acceptPaths === undefined ? {} : { acceptPaths: input.acceptPaths }),
      });
      const covers = result.destinations.map(describeDestination);
      const what = {
        created: "Created",
        adopted: "Took over",
        updated: "Updated",
        unchanged: "Kept",
      }[result.outcome];
      log.info(
        `${what} the Cloudflare Access application "${result.appName}"; it covers ${covers.join(", ")}, and lets in Appflare's users and Appflare's own health checks of this app.`,
      );
      if (result.bypass !== null && result.bypass.uris.length > 0) {
        log.info(`These paths stay public without a sign-in: ${result.bypass.uris.join(", ")}.`);
      } else if (result.bypass?.outcome === "removed") {
        log.info("The app has no public paths any more; their Access application was deleted.");
      }
      if (result.bypassProblem !== null) {
        log.warn(
          `The app's public paths could not be kept public (${result.bypassProblem}); they ask for a sign-in like the rest of the app.`,
        );
      }
      return {
        outcome: result.outcome,
        accessAppId: result.accessAppId,
        appName: result.appName,
        aud: result.aud,
        teamDomain: result.teamDomain,
        covers,
        bypass: result.bypass,
        bypassProblem: result.bypassProblem,
      };
    } catch (error) {
      throw asStepError(error);
    }
  });
}

export function runSyncInstallAccess(
  env: UnitEnv,
  deps: UnitDeps,
  input: SyncInstallAccessInput,
): Promise<UnitResult<SyncInstallAccessResult>> {
  return runUnit(env, deps, input.accountId, async ({ log, cf }) => {
    try {
      const outcome = await syncInstallAccessDestinations(
        accessDeps(env, deps, cf),
        input.installId,
        {
          ...(input.pendingExternalHosts === undefined
            ? {}
            : { pendingExternalHosts: input.pendingExternalHosts }),
          ...(input.bypassPaths === undefined ? {} : { change: { paths: input.bypassPaths } }),
        },
      );
      if (outcome === "updated") {
        log.info("Updated what the app's Cloudflare Access application covers.");
      }
      return { outcome };
    } catch (error) {
      throw asStepError(error);
    }
  });
}

export function runReleaseAppAccess(
  env: UnitEnv,
  deps: UnitDeps,
  input: ReleaseAppAccessInput,
): Promise<UnitResult<RemovalRelease>> {
  return runUnit(env, deps, input.accountId, async ({ cf }) => {
    try {
      return await releaseAppAccessForRemoval(accessDeps(env, deps, cf), input.installIds);
    } catch (error) {
      throw asStepError(error);
    }
  });
}

export function runUnprotectInstall(
  env: UnitEnv,
  deps: UnitDeps,
  input: UnprotectInstallInput,
): Promise<UnitResult<UnprotectInstallResult>> {
  return runUnit(env, deps, input.accountId, async ({ log, cf }) => {
    try {
      const result = await unprotectInstall(accessDeps(env, deps, cf), input.installId);
      log.info(
        result.removed
          ? "Deleted the app's Cloudflare Access application, its public paths and its service token."
          : "The app had no Cloudflare Access protection to remove.",
      );
      if (result.usersPolicy === "removed") {
        log.info(
          'No app is protected any more, so the "Appflare users" Access policy was deleted.',
        );
      }
      return { removed: result.removed };
    } catch (error) {
      throw asStepError(error);
    }
  });
}
