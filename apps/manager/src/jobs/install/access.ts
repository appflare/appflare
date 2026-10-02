import { eq } from "drizzle-orm";
import { appPlace } from "../../components/app-links";
import { install_access } from "../../db/schema";
import { startVarsRefreshCore } from "../../installs/reconfigure.server";
import { OFF_WORKERS_DEV } from "../../installs/workers-dev";
import { sandboxBinding } from "../../sandbox/binding";
import type { JobEnv } from "../run-job";
import { errorMessage, isNotFound, type JobSteps } from "../steps";
import { settleUnit } from "../units/result";

/**
 * The install job's Cloudflare Access phases, for an install the admin asked
 * to protect (`access: true`). Each Cloudflare change is one call of a job
 * unit (units/access.ts), in an invocation of its own over `SELF`, so the
 * job's own subrequest budget moves by one per phase.
 *
 * 1. Before anything of the app exists in the account: the install's Access
 *    application, covering the future workers.dev hostname of each of its
 *    Workers (and an external domain the form asked for) with `public`
 *    destinations. Access accepts a hostname nothing serves yet and guards
 *    it from the first request, and the application's audience tag and team
 *    domain are known from here on.
 * 2. After the last upload, before any route, domain or preview is turned
 *    on: the switch to one `worker` destination per Worker, which also
 *    covers its preview URLs, custom domains and routes. The audience tag
 *    stays. If the job fails between the first upload and the end of this
 *    switch, every Worker of the app is taken off workers.dev with its
 *    previews before the job fails (`keepWorkersUnreachablePhase`), so
 *    nothing of the app is reachable without Access.
 * 3. Once the install is recorded: the destinations brought in step with
 *    the domains the install really has, and its public paths made public.
 *    Never fails the job: the domain was covered from step 1 on, and a
 *    public path not yet public only asks for a sign-in.
 *
 * Either failure of 1 or 2 fails the install like any other step (the
 * install is `failed`, what was made stays recorded for the uninstall).
 */

export interface AccessProtection {
  accessAppId: string;
  /** The `aud` claim of the application's JWTs. */
  aud: string;
  /** `<team>.cloudflareaccess.com`. */
  teamDomain: string;
}

/** Step 1: the application, before any Worker exists. */
export async function protectBeforeUploadPhase(
  steps: JobSteps,
  input: {
    installId: string;
    appName: string;
    /** Every Worker of the app, by installed name, none uploaded yet. */
    workers: readonly string[];
    pendingExternalHosts: readonly string[];
    /** The entry's public paths, which the admin accepted by installing it protected. */
    acceptPaths: readonly string[];
  },
): Promise<AccessProtection> {
  return steps.run("protect with Cloudflare Access", async ({ log }) => {
    const result = settleUnit(
      await steps.units.api.protectInstall({
        accountId: steps.accountId(),
        installId: input.installId,
        appName: input.appName,
        workers: input.workers.map((name) => ({ name, tag: null })),
        pendingExternalHosts: [...input.pendingExternalHosts],
        acceptPaths: [...input.acceptPaths],
      }),
      log,
    );
    return { accessAppId: result.accessAppId, aud: result.aud, teamDomain: result.teamDomain };
  });
}

/**
 * Step 2: the switch to `worker` destinations, once every Worker is
 * uploaded. A Worker whose upload did not report its tag is looked up in
 * the account's script list by the unit.
 */
export async function coverWorkersPhase(
  steps: JobSteps,
  input: {
    installId: string;
    appName: string;
    workers: ReadonlyArray<{ name: string; tag: string | null | undefined }>;
    pendingExternalHosts: readonly string[];
    acceptPaths: readonly string[];
  },
): Promise<AccessProtection> {
  return steps.run("cover the app's Workers with Cloudflare Access", async ({ log }) => {
    const result = settleUnit(
      await steps.units.api.protectInstall({
        accountId: steps.accountId(),
        installId: input.installId,
        appName: input.appName,
        workers: input.workers.map((w) =>
          typeof w.tag === "string" ? { name: w.name, tag: w.tag } : { name: w.name },
        ),
        pendingExternalHosts: [...input.pendingExternalHosts],
        acceptPaths: [...input.acceptPaths],
      }),
      log,
    );
    return { accessAppId: result.accessAppId, aud: result.aud, teamDomain: result.teamDomain };
  });
}

/**
 * Turning protection on for an installed app (the settings change job with
 * `access: "on"`): the application covering the app's recorded Workers by
 * their tags (looked up in the account's script list), its external domains
 * (`public` destinations), and its public paths. The unit takes the Access
 * lock and reads the app's addresses under it, so an external domain
 * claimed meanwhile is covered too.
 */
export async function protectInstalledPhase(
  steps: JobSteps,
  installId: string,
): Promise<AccessProtection> {
  return steps.run("protect with Cloudflare Access", async ({ log }) => {
    const result = settleUnit(
      await steps.units.api.protectInstall({ accountId: steps.accountId(), installId }),
      log,
    );
    if (result.aud.length === 0) {
      log.warn(
        "Cloudflare did not report the audience tag of the app's Access application, so {{accessAud}} is empty.",
      );
    }
    return { accessAppId: result.accessAppId, aud: result.aud, teamDomain: result.teamDomain };
  });
}

/**
 * Turning protection off (the settings change job with `access: "off"`),
 * once the app's settings no longer carry its Access values: its public
 * paths, its application, its service token, and "Appflare users" when no
 * other app uses it.
 */
export async function unprotectPhase(steps: JobSteps, installId: string): Promise<void> {
  await steps.run("remove Cloudflare Access protection", async ({ log }) => {
    settleUnit(
      await steps.units.api.unprotectInstall({ accountId: steps.accountId(), installId }),
      log,
    );
    return {};
  });
}

/**
 * The install failed after its first upload and before Access covered its
 * Workers by their tags: each Worker is taken off workers.dev with its
 * previews, so none answers without Access. A Worker that was never
 * uploaded has nothing to turn off. Never throws, and leaves
 * `steps.current` (the step the install failed at) as it was.
 */
export async function keepWorkersUnreachablePhase(
  steps: JobSteps,
  workers: readonly string[],
): Promise<void> {
  const failedAt = steps.current;
  for (const name of workers) {
    try {
      await steps.run(`keep Worker ${name} unreachable`, async ({ log, cf }) => {
        try {
          await cf().workers.enableSubdomain(name, OFF_WORKERS_DEV);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          log.info(`The Worker "${name}" was not uploaded; there is nothing to turn off.`);
          return {};
        }
        log.warn(
          `Cloudflare Access does not cover the Worker "${name}" yet, so its workers.dev address and version previews are off.`,
        );
        return {};
      });
    } catch (error) {
      await steps
        .run(`Worker ${name} may be reachable`, async ({ log }) => {
          log.error(
            `Could not turn off the workers.dev address and previews of the Worker "${name}" (${errorMessage(error)}). Turn them off in the Cloudflare dashboard, or uninstall this app.`,
          );
          return {};
        })
        .catch(() => {});
    }
  }
  steps.current = failedAt;
}

/**
 * Step 3, and after an update, a rollback or a change of protection: the
 * application in step with the addresses the install really has (an
 * external domain the domain step did or did not add), and the app's public
 * paths (`access.bypass`) made public on each address, or taken off. Runs
 * after the install's manifest is recorded, which lists the paths; with
 * `bypassPaths`, before a version that drops some of them serves, keeping
 * only those it shares with the serving one. Never throws: a failure is
 * recorded on the install and the cron tries again, and until then a public
 * path asks for a sign-in like the rest of the app.
 */
export async function syncAccessPhase(
  steps: JobSteps,
  installId: string,
  opts: { bypassPaths?: readonly string[] } = {},
): Promise<void> {
  try {
    await steps.run(
      opts.bypassPaths === undefined
        ? "update Cloudflare Access destinations"
        : "take dropped public paths off Cloudflare Access",
      async ({ log }) => {
        settleUnit(
          await steps.units.api.syncInstallAccess({
            accountId: steps.accountId(),
            installId,
            ...(opts.bypassPaths === undefined ? {} : { bypassPaths: [...opts.bypassPaths] }),
          }),
          log,
        );
        return {};
      },
    );
  } catch (error) {
    await steps
      .run("Cloudflare Access destinations not updated", async ({ log, orm }) => {
        await orm
          .update(install_access)
          .set({ access_sync_failed_at: new Date(steps.now()) })
          .where(eq(install_access.install_id, installId));
        log.warn(
          `Could not bring the app's Cloudflare Access applications in step with its addresses and public paths (${errorMessage(error)}). The app stays protected; Appflare tries again within 30 minutes.`,
        );
        return {};
      })
      .catch(() => {});
  }
}

/**
 * After a rollback whose version's settings use the Access placeholders and
 * were deployed with another protection than the app has now (turned on or
 * off since, or not recorded): a settings refresh (`refreshVars:
 * ["access"]`) deploys them again with the current values, as a settings
 * change would. Runs once the rollback is recorded and the install is free
 * for the next job. Never throws; a refusal is a warning naming the way out.
 */
export async function accessValuesRefreshPhase(
  steps: JobSteps,
  env: Pick<JobEnv, "DB" | "JOBS" | "SANDBOX">,
  installId: string,
): Promise<void> {
  const later = `Turn Cloudflare Access protection on again (or off) under ${appPlace(installId, "settings", "the app's settings")} to fill in the current values.`;
  await steps
    .run("settings for the current Cloudflare Access protection", async ({ log }) => {
      const jobs = env.JOBS;
      if (jobs === undefined) {
        log.warn(`This version's settings carry Access values from another protection. ${later}`);
        return {};
      }
      try {
        const started = await startVarsRefreshCore(
          {
            db: env.DB,
            sandboxConnected: sandboxBinding(env) !== undefined,
            createJob: (id, params) => jobs.create({ id, params }),
            now: () => new Date(steps.now()),
            startedBy: "schedule",
          },
          installId,
          ["access"],
        );
        if (started !== null) {
          log.info(
            `This version's settings carry Access values from another protection than the app has now, so a settings change (job ${started.jobId}) deploys them again with the current ones.`,
          );
        }
      } catch (error) {
        log.warn(
          `This version's settings carry Access values from another protection than the app has now, and could not be deployed again (${errorMessage(error)}). ${later}`,
        );
      }
      return {};
    })
    .catch(() => undefined);
}
