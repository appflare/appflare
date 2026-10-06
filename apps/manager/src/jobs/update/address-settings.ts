import type { AccessPlaceholderValues, ArtifactManifest, JsonValue } from "@appflare/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { appPlace } from "../../components/app-links";
import { installs, resources } from "../../db/schema";
import type { VarsRefreshReason } from "../../installs/install-vars";
import { startVarsRefreshCore } from "../../installs/reconfigure.server";
import { ADDRESS_KINDS } from "../../installs/resource-kinds";
import { wildcardHostnameOf } from "../../installs/wildcard-domain-input";
import { appBaseUrl, domainHostnames } from "../../installs/workers-dev";
import { sandboxBinding } from "../../sandbox/binding";
import { type EntryWorker, entryPlaceholders } from "../entry-workers";
import { installVars } from "../install/metadata";
import type { JobEnv } from "../run-job";
import { errorMessage, type JobSteps, type StepTools } from "../steps";

/**
 * The values an app's settings are filled in with that follow where it is
 * served: `{{appUrl}}`/`{{appHostname}}` (its custom domain while
 * workers.dev is off, else its workers.dev URL) and `{{wildcardHostname}}`.
 *
 * An update renders them from the address the install has when the job
 * starts; a domain can go live or be removed while it runs (the settings
 * refresh such a change starts is refused while the update runs), so the
 * update compares once it is done and deploys the settings again when the
 * address moved. A rollback redeploys a version as it was uploaded, with the
 * address the app had then: it reads that version's vars back from
 * Cloudflare and deploys the settings again when they name another address
 * than the app has now. Both start the same settings refresh a domain change
 * starts (`startVarsRefreshCore`), which renders every var of the serving
 * version, as an update renders it, with the current values.
 */

/** Where the app is served now, as the jobs fill it in. */
export interface AppAddress {
  /** What `{{appUrl}}` becomes. */
  appUrl: string;
  /** What `{{wildcardHostname}}` becomes; null without a wildcard domain. */
  wildcardHostname: string | null;
}

/** The install's address as recorded now (live domains first, the workers.dev switch). */
export async function readAppAddress(
  orm: StepTools["orm"],
  installId: string,
  subdomain: string,
): Promise<AppAddress | null> {
  const [install] = await orm
    .select({
      workerName: installs.worker_name,
      workersDev: installs.workers_dev_enabled,
      served: installs.served_domain,
    })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) return null;
  const rows = await orm
    .select({
      id: resources.id,
      kind: resources.kind,
      name: resources.name,
      live_at: resources.live_at,
    })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        inArray(resources.kind, [...ADDRESS_KINDS]),
        isNull(resources.deleted_at),
      ),
    );
  return {
    appUrl: appBaseUrl({
      workerName: install.workerName,
      subdomain,
      workersDev: install.workersDev,
      domains: domainHostnames(rows),
      served: install.served,
    }),
    wildcardHostname: wildcardHostnameOf(rows),
  };
}

/** The values that differ between two addresses. */
export function changedAddress(before: AppAddress, now: AppAddress): VarsRefreshReason[] {
  const changed: VarsRefreshReason[] = [];
  if (before.appUrl !== now.appUrl) changed.push("appUrl");
  if (before.wildcardHostname !== now.wildcardHostname) changed.push("wildcardHostname");
  return changed;
}

/** Stand-ins that tell which vars an address value ends up in. */
const MARKER_URL = "https://app-url.appflare.invalid";
const MARKER_HOST = "wildcard-hostname.appflare.invalid";

/** JSON with sorted keys, so two equal values compare equal however their keys are ordered. */
function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Var bindings (`plain_text`, `json`) by name, as comparable text; others are left out. */
export function varValues(bindings: readonly unknown[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const b of bindings) {
    if (typeof b !== "object" || b === null) continue;
    const { type, name, text, json } = b as {
      type?: unknown;
      name?: unknown;
      text?: unknown;
      json?: unknown;
    };
    if (typeof name !== "string") continue;
    if (type === "plain_text" && typeof text === "string") values.set(name, `text:${text}`);
    else if (type === "json" && json !== undefined) {
      values.set(name, `json:${stableJson(json as JsonValue)}`);
    }
  }
  return values;
}

/**
 * Which address values the vars of `worker` (one Worker of `manifest`, the
 * app's whole entry) use and a version with `deployed` vars does not carry
 * as they are now: each var filled in with `address` is compared with the
 * deployed one, for the vars a change of that value would change. Pure.
 */
export function staleAddressValues(input: {
  manifest: ArtifactManifest;
  worker: Pick<EntryWorker, "manifest">;
  userVars: Readonly<Record<string, string>>;
  workerName: string;
  subdomain: string;
  accountId: string;
  access: AccessPlaceholderValues | null;
  address: AppAddress;
  deployed: readonly unknown[];
}): VarsRefreshReason[] {
  const render = (address: AppAddress) => {
    const entry = entryPlaceholders(
      input.manifest,
      input.workerName,
      input.subdomain,
      address.appUrl,
    );
    return varValues(
      installVars(input.worker.manifest, input.userVars, {
        workerName: input.workerName,
        subdomain: input.subdomain,
        accountId: input.accountId,
        appUrl: address.appUrl,
        wildcardHostname: address.wildcardHostname,
        access: input.access,
        ...(entry === undefined ? {} : { entryWorkers: entry }),
      }).vars,
    );
  };
  const now = render(input.address);
  const deployed = varValues(input.deployed);
  const stale = (probe: Map<string, string>) =>
    [...now].some(([name, value]) => probe.get(name) !== value && deployed.get(name) !== value);
  const reasons: VarsRefreshReason[] = [];
  if (stale(render({ ...input.address, appUrl: MARKER_URL }))) reasons.push("appUrl");
  if (stale(render({ ...input.address, wildcardHostname: MARKER_HOST }))) {
    reasons.push("wildcardHostname");
  }
  return reasons;
}

const VALUE_WORDS: Readonly<Record<VarsRefreshReason, string>> = {
  appUrl: "address ({{appUrl}})",
  wildcardHostname: "wildcard domain ({{wildcardHostname}})",
  access: "Cloudflare Access values",
};

/** "address ({{appUrl}}) and wildcard domain ({{wildcardHostname}})". */
export function describeValues(changed: readonly VarsRefreshReason[]): string {
  const words = changed.map((c) => VALUE_WORDS[c]);
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * Starts the settings refresh for `changed` once the job that found them is
 * done (the install is free for the next job): the serving version is
 * deployed again with the current values. `why` opens the log line. Never
 * throws; a refusal is a warning naming the way out.
 */
export async function settingsRefreshPhase(
  steps: JobSteps,
  env: Pick<JobEnv, "DB" | "JOBS" | "SANDBOX">,
  installId: string,
  changed: readonly VarsRefreshReason[],
  why: string,
): Promise<void> {
  const later = `Save the app's settings under ${appPlace(installId, "settings", "the app's settings")} to fill in the current ${describeValues(changed)}.`;
  await steps
    .run("settings for the app's current address", async ({ log }) => {
      const jobs = env.JOBS;
      if (jobs === undefined) {
        log.warn(`${why}. ${later}`);
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
          changed,
        );
        if (started !== null) {
          log.info(
            `${why}, so a settings change (job ${started.jobId}) deploys them again with the current ${describeValues(changed)}.`,
          );
        }
      } catch (error) {
        log.warn(`${why}, and they could not be deployed again (${errorMessage(error)}). ${later}`);
      }
      return {};
    })
    .catch(() => undefined);
}
