import { OFF_WORKERS_DEV } from "../../installs/workers-dev";
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
 * 3. After an external domain was added (or not): the destinations brought
 *    in step with the domains the install really has. Never fails the job:
 *    the domain was covered from step 1 on.
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
      }),
      log,
    );
    return { accessAppId: result.accessAppId, aud: result.aud, teamDomain: result.teamDomain };
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
 * Step 3: the destinations in step with the external domains the install
 * really has, once its domain step ran. Never throws.
 */
export async function syncAccessAfterDomainPhase(
  steps: JobSteps,
  installId: string,
): Promise<void> {
  try {
    await steps.run("update Cloudflare Access destinations", async ({ log }) => {
      settleUnit(
        await steps.units.api.syncInstallAccess({ accountId: steps.accountId(), installId }),
        log,
      );
      return {};
    });
  } catch (error) {
    await steps
      .run("Cloudflare Access destinations not updated", async ({ log }) => {
        log.warn(
          `Could not bring the app's Cloudflare Access application in step with its domains (${errorMessage(error)}). The app stays protected; the application may still list a domain the app does not have.`,
        );
        return {};
      })
      .catch(() => {});
  }
}
