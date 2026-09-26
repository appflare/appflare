import type { HyperdriveProtocol } from "@appflare/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { resources } from "../../db/schema";
import {
  HYPERDRIVE_KIND,
  HYPERDRIVE_KINDS,
  HYPERDRIVE_SUPERSEDED_KIND,
} from "../../installs/resource-kinds";
import {
  createHyperdriveConfig,
  explainHyperdriveRefusal,
  recordResource,
  resourceId,
} from "../install/phases";
import { deleteResource, RESOURCE_LABEL } from "../install/resources";
import { isNotFound, type JobSteps } from "../steps";
import { replacementConfigName } from "./plan";

/**
 * Replacing a database's connection string in a settings change: a new
 * Hyperdrive configuration is created from the new string before the new
 * version is uploaded, and the version binds it. Once that version serves
 * all traffic, the records move to the new configuration and the old one is
 * kept as superseded: the version the change's snapshot recorded still binds
 * it, so a rollback to that snapshot still reaches the database. Superseded
 * configurations are deleted by the next successful update or settings
 * change (whose own snapshot is then the latest) and by an uninstall. A
 * change that fails before the promotion deletes the configuration it made.
 */

const LABEL = RESOURCE_LABEL.hyperdrive;

/** A recorded Hyperdrive configuration, as a job addresses it. */
export interface RecordedConfig {
  rowId: string;
  name: string;
  cfId: string;
}

/** One database whose configuration a settings change replaces. */
export interface ConnectionReplacement {
  binding: string;
  /** The recorded configuration the Worker binds now. */
  old: RecordedConfig;
  /** The configuration made from the new connection string. */
  next: RecordedConfig;
}

/**
 * Steps "create/record Hyperdrive configuration <name>": a configuration
 * named after the install's Worker, the binding and this job, made from `connection` (read
 * inside the step only, never returned or logged), recorded without a
 * binding until the version that binds it serves.
 */
export async function createReplacementPhase(
  steps: JobSteps,
  input: {
    installId: string;
    jobId: string;
    /** The install's Worker name, which names its resources. */
    workerName: string;
    binding: string;
    protocol: HyperdriveProtocol;
    current: RecordedConfig;
    connection: string | undefined;
  },
): Promise<ConnectionReplacement> {
  const name = replacementConfigName(input.workerName, input.binding, input.jobId);
  const plan = {
    type: "hyperdrive" as const,
    kind: "hyperdrive" as const,
    binding: input.binding,
    name,
    protocol: input.protocol,
  };
  const made = await steps.run(`create ${LABEL} ${name}`, async ({ log, cf, attempt }) => {
    const api = cf();
    // The name carries this job's id, so one that exists on a retry is the
    // one this step's own earlier attempt created before it failed.
    if (attempt > 1) {
      const existing = (await explainHyperdriveRefusal(() => api.hyperdrive.listConfigs())).find(
        (c) => c.name === name,
      );
      if (existing !== undefined) {
        log.info(`Found the ${LABEL} "${name}" an earlier attempt created.`, { id: existing.id });
        return { cfId: existing.id };
      }
    }
    const cfId = await createHyperdriveConfig(api, plan, input.connection);
    log.info(
      `Created ${LABEL} "${name}" from the new connection string for ${input.binding}; "${input.current.name}" keeps serving until the new version takes over.`,
      { id: cfId },
    );
    return { cfId };
  });
  const rowId = resourceId(input.installId, HYPERDRIVE_KIND, name);
  await steps.run(`record ${LABEL} ${name}`, async ({ orm }) => {
    await recordResource(
      orm,
      input.installId,
      { kind: HYPERDRIVE_KIND, key: name, binding: null, name, cfId: made.cfId },
      new Date(steps.now()),
    );
    return {};
  });
  return { binding: input.binding, old: input.current, next: { rowId, name, cfId: made.cfId } };
}

/**
 * Records that the Worker binds the new configurations: each binding moves
 * to the new record, and the old record becomes superseded (keeping its
 * binding's name, for a rollback that binds it again). Writing it again
 * changes nothing.
 */
export async function switchConnectionRecords(
  orm: Database,
  installId: string,
  replacements: readonly ConnectionReplacement[],
): Promise<void> {
  for (const r of replacements) {
    await orm
      .update(resources)
      .set({ kind: HYPERDRIVE_SUPERSEDED_KIND })
      .where(and(eq(resources.install_id, installId), eq(resources.id, r.old.rowId)));
    await orm
      .update(resources)
      .set({ binding: r.binding })
      .where(and(eq(resources.install_id, installId), eq(resources.id, r.next.rowId)));
  }
}

/** The live superseded configurations among an install's resource rows. */
export function supersededConfigs(
  rows: ReadonlyArray<{ id: string; kind: string; name: string; cfId: string | null }>,
): RecordedConfig[] {
  return rows.flatMap((r) =>
    r.kind === HYPERDRIVE_SUPERSEDED_KIND && r.cfId !== null
      ? [{ rowId: r.id, name: r.name, cfId: r.cfId }]
      : [],
  );
}

/**
 * Step "delete Hyperdrive configuration <name>": deletes a configuration no
 * version the latest snapshot or the serving version binds, and marks its
 * record deleted. A configuration already gone counts as deleted.
 */
export async function deleteConfigPhase(
  steps: JobSteps,
  config: RecordedConfig,
  /** The end of the log line, after the name (", which DB used before"). */
  why: string,
): Promise<void> {
  await steps.run(`delete ${LABEL} ${config.name}`, async ({ log, cf, orm }) => {
    try {
      await deleteResource(cf(), { kind: "hyperdrive", name: config.name, cfId: config.cfId });
      log.info(`Deleted ${LABEL} "${config.name}"${why}.`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      log.info(`${LABEL} "${config.name}" was already gone.`);
    }
    await orm
      .update(resources)
      .set({ deleted_at: new Date(steps.now()) })
      .where(eq(resources.id, config.rowId));
    return {};
  });
}

/**
 * After a successful update or settings change: deletes the configurations
 * that were superseded when it started. Only an older snapshot's version
 * binds them, and the job's own snapshot is the latest now. Configurations
 * this job superseded itself are not in `configs` and stay.
 */
export async function deleteSupersededPhase(
  steps: JobSteps,
  configs: readonly RecordedConfig[],
): Promise<void> {
  for (const config of configs) {
    await deleteConfigPhase(
      steps,
      config,
      ", which an earlier settings change replaced; only versions before the latest snapshot bound it",
    );
  }
}

/** The ids of the install's Hyperdrive configurations that are not deleted, bound or superseded. */
export async function liveHyperdriveIds(orm: Database, installId: string): Promise<Set<string>> {
  const rows = await orm
    .select({ cfId: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        inArray(resources.kind, [...HYPERDRIVE_KINDS]),
        isNull(resources.deleted_at),
      ),
    );
  return new Set(rows.flatMap((r) => (r.cfId === null ? [] : [r.cfId])));
}

/** A version's Hyperdrive bindings (binding name, configuration id), from `GET .../versions/{id}`. */
export function versionHyperdriveBindings(version: {
  resources?: Record<string, unknown>;
}): Array<{ binding: string; id: string }> {
  const bindings = version.resources?.bindings;
  if (!Array.isArray(bindings)) return [];
  const out: Array<{ binding: string; id: string }> = [];
  for (const b of bindings) {
    if (typeof b !== "object" || b === null) continue;
    const { type, name, id } = b as { type?: unknown; name?: unknown; id?: unknown };
    if (type === "hyperdrive" && typeof name === "string" && typeof id === "string") {
      out.push({ binding: name, id });
    }
  }
  return out;
}

/**
 * Makes the records follow the configurations a version binds, after a
 * rollback to it: a recorded configuration the version binds becomes the
 * bound one for its binding, and the one bound until then becomes
 * superseded (the next successful update or settings change deletes it).
 * Returns the bindings whose configuration changed, and those whose
 * configuration has no live record (deleted since, or never recorded),
 * which the caller warns about.
 */
export async function reconcileHyperdriveRecords(
  orm: Database,
  installId: string,
  bound: ReadonlyArray<{ binding: string; id: string }>,
): Promise<{ rebound: string[]; missing: string[] }> {
  const rows = await orm
    .select({
      id: resources.id,
      kind: resources.kind,
      binding: resources.binding,
      cfId: resources.cf_id,
    })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        inArray(resources.kind, [...HYPERDRIVE_KINDS]),
        isNull(resources.deleted_at),
      ),
    );
  const changed: string[] = [];
  const missing: string[] = [];
  for (const { binding, id } of bound) {
    const target = rows.find((r) => r.cfId === id);
    if (target === undefined) {
      missing.push(binding);
      continue;
    }
    if (target.kind === HYPERDRIVE_KIND && target.binding === binding) continue;
    for (const other of rows) {
      if (other.kind === HYPERDRIVE_KIND && other.binding === binding && other.id !== target.id) {
        await orm
          .update(resources)
          .set({ kind: HYPERDRIVE_SUPERSEDED_KIND })
          .where(eq(resources.id, other.id));
      }
    }
    await orm
      .update(resources)
      .set({ kind: HYPERDRIVE_KIND, binding })
      .where(eq(resources.id, target.id));
    changed.push(binding);
  }
  return { rebound: changed, missing };
}
