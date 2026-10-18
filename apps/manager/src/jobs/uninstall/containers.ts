import {
  CloudflareApiError,
  type CloudflareClient,
  UNREADABLE_CONTAINER_APPLICATIONS,
} from "@appflare/cf-api";
import { isNotFound, type JobSteps } from "../steps";

/**
 * Container applications behind the app's Durable Objects. A container
 * application backs one Durable Object namespace, and deleting the Worker
 * that implements the namespace leaves the application behind, its
 * instances still running and billed (seen on a Workers Paid account), so
 * the uninstall deletes them itself, before the Workers: an application
 * names the namespace it backs (`durable_objects.namespace_id`), and the
 * namespace names its Worker (`script`) only while that Worker exists.
 *
 * Containers need Workers Paid: Cloudflare answers 401 on any other account,
 * which has none to delete. On Workers Paid a 401 is a credential problem
 * instead, and the account may well run the app's containers. A token
 * without the optional Containers permission gets 403 whatever the plan.
 */

/** A container application of the app, to delete. */
export interface AppContainer {
  id: string;
  name: string;
}

/** What the account's container applications say about the app's. */
export type ContainerLookup =
  | { kind: "found"; apps: AppContainer[] }
  /**
   * Cloudflare answered 401: off Workers Paid it refuses Containers to the
   * account; on Workers Paid it did not accept the token for them.
   */
  | { kind: "no-containers" }
  /** The token cannot read Containers. */
  | { kind: "refused" };

function refusedWith(error: unknown, status: number): boolean {
  return error instanceof CloudflareApiError && error.status === status;
}

/** The Durable Object namespaces `workers` implement. */
async function namespacesOf(api: CloudflareClient, workers: readonly string[]) {
  const names = new Set(workers);
  return (await api.workers.listDurableObjectNamespaces()).filter(
    (ns) => ns.script !== undefined && names.has(ns.script),
  );
}

/**
 * The container applications that back a Durable Object namespace of one of
 * `workers`. Reads the account's applications first (one call, and an
 * account with none needs nothing more), then its namespaces.
 */
export async function findAppContainers(
  api: CloudflareClient,
  workers: readonly string[],
): Promise<ContainerLookup> {
  let apps: Awaited<ReturnType<typeof api.containers.listApplications>>;
  try {
    apps = await api.containers.listApplications();
  } catch (error) {
    if (refusedWith(error, 401)) return { kind: "no-containers" };
    if (refusedWith(error, 403)) return { kind: "refused" };
    throw error;
  }
  if (apps.length === 0) return { kind: "found", apps: [] };
  const ids = new Set((await namespacesOf(api, workers)).map((ns) => ns.id));
  return {
    kind: "found",
    apps: apps
      .filter((a) => {
        const namespace = a.durable_objects?.namespace_id;
        return namespace !== undefined && ids.has(namespace);
      })
      .map((a) => ({ id: a.id, name: a.name })),
  };
}

/** Where the log sends the admin to check by hand. */
const DASHBOARD_PLACE = "Workers > Containers in the Cloudflare dashboard";

/**
 * Finds the app's container applications, in one step whose result is the
 * record a retried or resumed job reads back.
 */
export async function findContainersPhase(
  steps: JobSteps,
  workers: readonly string[],
  /** Whether the account is known to be on Workers Paid, the one plan that runs containers. */
  accountPaid: boolean,
): Promise<AppContainer[]> {
  if (workers.length === 0) return [];
  const { apps } = await steps.run("check container applications", async ({ log, cf }) => {
    const api = cf();
    const none: AppContainer[] = [];
    let lookup: ContainerLookup;
    try {
      lookup = await findAppContainers(api, workers);
    } catch (error) {
      // Off Workers Paid no container can run, so a Containers API that
      // fails (it answered 500 once on Workers Free) never stops the uninstall.
      const unreadable = error instanceof Error && error.name === UNREADABLE_CONTAINER_APPLICATIONS;
      if (accountPaid || !(error instanceof CloudflareApiError || unreadable)) throw error;
      const answered =
        error instanceof CloudflareApiError
          ? `Cloudflare answered ${error.status} when asked for the account's container applications.`
          : "Cloudflare's answer for the account's container applications held no list.";
      log.warn(
        `${answered} Containers run only on Workers Paid, which this account is not on as far as Appflare knows; if ${DASHBOARD_PLACE} lists one for this app, delete it there.`,
      );
      return { apps: none };
    }
    if (lookup.kind === "no-containers" && !accountPaid) {
      log.info(
        "Cloudflare runs containers only on Workers Paid and refuses them to this account, so the app has no container applications.",
      );
      return { apps: none };
    }
    if (lookup.kind === "refused" && !accountPaid) {
      log.info(
        "Appflare's API token cannot read Containers, which Cloudflare runs only on Workers Paid; this account is not on it as far as Appflare knows, so the app has no container applications.",
      );
      return { apps: none };
    }
    if (lookup.kind !== "found") {
      // On Workers Paid the app may run containers Appflare cannot see, and
      // only a Durable Object runs one, so the log names the app's classes.
      const classes = (await namespacesOf(api, workers)).map((ns) => ns.class ?? ns.name ?? ns.id);
      if (classes.length === 0) {
        log.info("The app has no Durable Objects, so no container application runs for it.");
      } else {
        const cause =
          lookup.kind === "refused"
            ? "Appflare's API token cannot read Containers (Account > Containers)"
            : "Cloudflare answered 401 when asked for the account's container applications: on Workers Paid that means it did not accept Appflare's API token for Containers";
        log.warn(
          `${cause}, so Appflare could not check whether a container application runs behind the app's Durable Objects (${classes.join(", ")}). If ${DASHBOARD_PLACE} lists one for this app, delete it there: it keeps running, and billing, once the Worker is gone.`,
        );
      }
      return { apps: none };
    }
    log.info(
      lookup.apps.length === 0
        ? "No container application runs for the app."
        : `Container applications of the app: ${lookup.apps.map((a) => a.name).join(", ")}.`,
    );
    return { apps: lookup.apps };
  });
  return apps;
}

/**
 * Deletes each container application, a step each, so a retry repeats only
 * what is left. One that is already gone counts as deleted. `afterInstaller`:
 * they were found before an app's own installer ran its destroy command, and
 * the log says which ones it left.
 */
export async function deleteContainersPhase(
  steps: JobSteps,
  apps: readonly AppContainer[],
  opts: { afterInstaller?: boolean } = {},
): Promise<void> {
  for (const app of apps) {
    await steps.run(`delete container application ${app.name}`, async ({ log, cf }) => {
      try {
        await cf().containers.deleteApplication(app.id);
        if (opts.afterInstaller === true) {
          log.warn(
            `The installer's destroy command left the container application "${app.name}" running; deleted it, and its instances stop with it.`,
          );
        } else {
          log.info(`Deleted the container application "${app.name}"; its instances stop with it.`);
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
        log.info(
          opts.afterInstaller === true
            ? `The installer's destroy command deleted the container application "${app.name}".`
            : `The container application "${app.name}" was already gone.`,
        );
      }
      return {};
    });
  }
}

/** Uninstall: finds the app's container applications, then deletes each. */
export async function deleteAppContainersPhase(
  steps: JobSteps,
  workers: readonly string[],
  accountPaid: boolean,
): Promise<void> {
  await deleteContainersPhase(steps, await findContainersPhase(steps, workers, accountPaid));
}
