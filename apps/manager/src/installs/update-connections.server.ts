import {
  type CatalogManifest,
  connectionStringProblems,
  type HyperdriveDeclaration,
  hyperdriveDeclarations,
} from "@appflare/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import { resources } from "../db/schema";
import {
  hyperdriveBindingsOf,
  newDatabases,
  newStreamTokenSecrets,
  replaceableDatabases,
} from "../jobs/update/plan";
import { PIPELINE_KIND, PIPELINE_SINK_KIND, PIPELINE_STREAM_KIND } from "./resource-kinds";

/**
 * What every way of starting an update asks the admin for when the new
 * version connects to a database elsewhere or streams events: the connection
 * string of each database the install has no Hyperdrive configuration for,
 * and the token of each sink the update makes (asked for again when the
 * Worker has it, since Cloudflare never hands a secret back). It also offers,
 * optionally, to replace the connection of a database an earlier update set
 * up that the installed version does not use. The update dialog and the
 * update from a reviewed build both use it, so no update stops at the job's
 * plan for something the admin could have given.
 */

export interface UpdateConnections {
  /** Databases the version adds; the start path asks for a connection string for each. */
  databases: HyperdriveDeclaration[];
  /**
   * Databases whose configuration an earlier update made that the installed
   * version does not declare; a connection string for one is optional and
   * replaces that configuration.
   */
  replaceable: HyperdriveDeclaration[];
  /** Secrets holding the tokens of the sinks the update makes; asked for like new secrets. */
  streamTokens: string[];
}

/** The resource kinds {@link updateConnectionsOf} reads. */
export const UPDATE_CONNECTION_KINDS = [
  "hyperdrive",
  PIPELINE_STREAM_KIND,
  PIPELINE_SINK_KIND,
  PIPELINE_KIND,
] as const;

/** {@link UpdateConnections} from the install's live resource rows (those kinds at least). */
export function updateConnectionsOf(
  install: { worker_name: string; manifest_json: string | null },
  catalog: Pick<CatalogManifest, "resources">,
  recorded: ReadonlyArray<{ kind: string; binding: string | null; name: string }>,
): UpdateConnections {
  const declared = hyperdriveDeclarations(catalog.resources?.hyperdrive);
  return {
    databases: newDatabases(declared, recorded),
    replaceable: replaceableDatabases(
      declared,
      recorded,
      hyperdriveBindingsOf(install.manifest_json),
    ),
    streamTokens: newStreamTokenSecrets(
      install.worker_name,
      catalog.resources?.pipelines,
      recorded,
    ),
  };
}

/** {@link UpdateConnections} of updating the install to a version with this catalog manifest. */
export async function readUpdateConnections(
  db: D1Database,
  install: { id: string; worker_name: string; manifest_json: string | null },
  catalog: Pick<CatalogManifest, "resources">,
): Promise<UpdateConnections> {
  const recorded = await createDb(db)
    .select({ kind: resources.kind, binding: resources.binding, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, install.id),
        inArray(resources.kind, [...UPDATE_CONNECTION_KINDS]),
        isNull(resources.deleted_at),
      ),
    );
  return updateConnectionsOf(install, catalog, recorded);
}

/**
 * The connection strings an update takes, trimmed, by binding: one for each
 * of `databases`, and one for any of `replaceable` the admin filled in (an
 * empty one keeps the configuration), checked as the install form checks
 * them. `problem` is set, naming the binding and the part at fault and
 * never any of the string, when they cannot be used.
 */
export function checkUpdateConnections(
  databases: readonly HyperdriveDeclaration[],
  given: Readonly<Record<string, string>>,
  replaceable: readonly HyperdriveDeclaration[] = [],
): { connections: Record<string, string>; problem: string | null } {
  const known = (b: string) =>
    databases.some((d) => d.binding === b) || replaceable.some((d) => d.binding === b);
  const unknown = Object.keys(given).filter((b) => !known(b));
  if (unknown.length > 0) {
    return {
      connections: {},
      problem: `This update does not take a connection string for: ${unknown.join(", ")}.`,
    };
  }
  const required: Record<string, string> = {};
  const replacing: Record<string, string> = {};
  for (const [binding, raw] of Object.entries(given)) {
    const value = raw.trim();
    if (databases.some((d) => d.binding === binding)) required[binding] = value;
    else if (value.length > 0) replacing[binding] = value;
  }
  const problems = [
    ...connectionStringProblems(databases, required),
    ...connectionStringProblems(
      replaceable.filter((d) => replacing[d.binding] !== undefined),
      replacing,
    ),
  ];
  return {
    connections: { ...required, ...replacing },
    problem: problems.length === 0 ? null : problems.join(" "),
  };
}
