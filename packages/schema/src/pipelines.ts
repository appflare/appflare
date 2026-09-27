import { z } from "zod";

/**
 * Apps that stream events into R2 through Cloudflare Pipelines. The app's
 * wrangler config binds a stream (`pipelines: [{ binding, stream }]`); the
 * stream's id belongs to one account, so the catalog manifest describes the
 * stream instead, under `resources.pipelines.<binding>`: its schema and the
 * Iceberg table in R2 Data Catalog its events land in. The install creates
 * the stream, the sink, and the pipeline between them (a pass-through
 * `INSERT INTO <sink> SELECT * FROM <stream>`), and binds the stream.
 *
 * Pipelines is in open beta and needs Workers Paid
 * (developers.cloudflare.com/pipelines), so an app with a stream is a Workers
 * Paid app. Its API (`/accounts/{id}/pipelines/v1`) creates streams, sinks
 * and pipelines that cannot be changed afterwards: an update keeps the ones
 * the install made. Client-safe.
 */

/**
 * The binding type of a Pipelines stream, as wrangler 4.136.2 uploads it:
 * `{ type: "pipelines", name, stream: <stream id> }` (`pipeline: <id>`, the
 * field's name before June 2026, still works).
 */
export const PIPELINES_BINDING_TYPE = "pipelines";

/** Most Pipelines bindings one app may declare; an account has 20 streams while Pipelines is in beta. */
export const MAX_PIPELINE_BINDINGS = 5;

/** Most fields a stream schema may declare. */
export const MAX_STREAM_FIELDS = 256;

/** The shortest roll interval Cloudflare allows an R2 Data Catalog sink, in seconds. */
export const MIN_CATALOG_ROLL_INTERVAL_SECONDS = 60;

/**
 * Field types of a stream schema (`cloudflare-pipelines_SourceField` in the
 * API schema), without the nested `struct` and `list` types: a nested value
 * can be sent as a `json` field.
 */
export const STREAM_FIELD_TYPES = [
  "int32",
  "int64",
  "float32",
  "float64",
  "bool",
  "string",
  "binary",
  "timestamp",
  "json",
] as const;
export type StreamFieldType = (typeof STREAM_FIELD_TYPES)[number];

/** Units of a `timestamp` field. */
export const TIMESTAMP_UNITS = ["second", "millisecond", "microsecond", "nanosecond"] as const;

/** Parquet compressions an R2 Data Catalog sink writes with. */
export const SINK_COMPRESSIONS = ["zstd", "snappy", "gzip", "lz4", "uncompressed"] as const;

/**
 * A name Iceberg and Pipelines SQL accept unquoted: a letter or underscore,
 * then letters, digits and underscores.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One field of a stream's schema. */
export const streamFieldSchema = z
  .object({
    name: z.string().min(1).max(128).describe("The field's name in each event."),
    type: z.enum(STREAM_FIELD_TYPES).describe("The field's type."),
    required: z
      .boolean()
      .describe("Every event carries the field. Cloudflare drops an event that lacks it.")
      .optional(),
    unit: z
      .enum(TIMESTAMP_UNITS)
      .describe("For a `timestamp` field sent as a number: what the number counts.")
      .optional(),
  })
  .refine((f) => f.unit === undefined || f.type === "timestamp", {
    message: "unit is only for timestamp fields",
    path: ["unit"],
  });
export type StreamField = z.infer<typeof streamFieldSchema>;

/** Table maintenance R2 Data Catalog runs with the sink's token. */
export const snapshotExpirationSchema = z.object({
  maxAge: z
    .string()
    .regex(/^\d+[dhms]$/)
    .describe('Snapshots older than this are expired, such as `"30d"` (d, h, m or s).'),
  minSnapshotsToKeep: z.int().min(1).describe("Snapshots kept however old they are.").optional(),
});
export type SnapshotExpiration = z.infer<typeof snapshotExpirationSchema>;

/** Where a stream's events land: an Iceberg table in an R2 bucket's Data Catalog. */
export const catalogPipelineSinkSchema = z.object({
  type: z
    .literal("r2_data_catalog")
    .describe("An Apache Iceberg table in R2 Data Catalog, the only sink Appflare sets up."),
  bucket: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .describe(
      "The bucket the table lives in. The name of an R2 binding of the app's wrangler config " +
        "uses that binding's bucket; any other name gets a bucket of the install's own, named " +
        "`<worker name>-<name lowercased, _ as ->` like every resource Appflare creates, which no " +
        "Worker binds (the app reaches it through R2 SQL, for example).",
    ),
  namespace: z
    .string()
    .max(128)
    .regex(IDENTIFIER)
    .describe("The table's namespace in the bucket's catalog."),
  table: z.string().max(128).regex(IDENTIFIER).describe("The table's name in the namespace."),
  tokenSecret: z
    .string()
    .min(1)
    .describe(
      "The catalog secret that holds a Cloudflare API token with R2 Data Catalog and R2 " +
        "Storage write access (the dashboard's R2 token with Admin Read & Write). Cloudflare " +
        "keeps it as the sink's credential, and as the catalog's for table maintenance; " +
        "Appflare's own token never leaves the manager. The secret must be asked for (no " +
        "`generate`, `optional`, `derive` or `seedOnly`).",
    ),
  rollIntervalSeconds: z
    .int()
    .min(MIN_CATALOG_ROLL_INTERVAL_SECONDS)
    .max(86_400)
    .describe(
      "How often the sink writes a file, in seconds: at least 60 for a catalog sink. " +
        "Cloudflare's default is 300.",
    )
    .optional(),
  compression: z
    .enum(SINK_COMPRESSIONS)
    .describe("The Parquet compression. Cloudflare's default is zstd.")
    .optional(),
  compaction: z
    .boolean()
    .describe("Turn on the catalog's automatic compaction, which merges the sink's small files.")
    .optional(),
  snapshotExpiration: snapshotExpirationSchema
    .describe("Turn on the catalog's snapshot expiration, which deletes old snapshots' files.")
    .optional(),
});
export type CatalogPipelineSink = z.infer<typeof catalogPipelineSinkSchema>;

/** One Pipelines binding of the app's wrangler config, as the catalog manifest describes it. */
export const catalogPipelineSchema = z.object({
  schema: z
    .object({
      fields: z
        .array(streamFieldSchema)
        .min(1)
        .max(MAX_STREAM_FIELDS)
        .describe(
          "The fields of each event, in order. Pipelines adds `__ingest_ts` itself; do not list it.",
        ),
    })
    .describe(
      "The stream's schema. Cloudflare drops events that do not match it. Omitted: the stream " +
        "is unstructured and every event lands in one `value` column.",
    )
    .optional(),
  sink: catalogPipelineSinkSchema.describe(
    "Where the stream's events land: an Iceberg table in an R2 bucket's Data Catalog, written " +
      "with the API token the admin enters for the app.",
  ),
});
export type CatalogPipeline = z.infer<typeof catalogPipelineSchema>;

/** `resources.pipelines`: the declarations by binding name. */
export const catalogPipelinesSchema = z
  .record(z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/), catalogPipelineSchema)
  .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= MAX_PIPELINE_BINDINGS, {
    message: `declare between 1 and ${MAX_PIPELINE_BINDINGS} Pipelines bindings`,
  })
  .describe(
    "The Pipelines bindings of the wrangler config, keyed by binding name: each stream's schema " +
      "and the Iceberg table its events land in. Appflare creates the stream, an R2 Data Catalog " +
      'sink and a pass-through pipeline for each, and binds the stream. Needs `plan: "paid"` ' +
      "(Pipelines is on Workers Paid only). Not allowed on self-deploying entries.",
  );
export type CatalogPipelines = z.infer<typeof catalogPipelinesSchema>;

/**
 * Why a Worker's Pipelines bindings and `resources.pipelines` disagree, one
 * sentence each; empty when every binding is declared and every declaration
 * is bound. The manager creates a stream per declaration and binds one per
 * binding, so the two must match.
 */
export function pipelineDeclarationProblems(
  bindings: ReadonlyArray<{ type: string; name: string }>,
  declared: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  const bound = new Set<string>();
  for (const binding of bindings) {
    if (binding.type !== PIPELINES_BINDING_TYPE) continue;
    bound.add(binding.name);
    if (!Object.hasOwn(declared, binding.name)) {
      problems.push(
        `Pipelines binding ${binding.name} is not declared in the catalog manifest's resources.pipelines, so Appflare does not know which stream to create for it.`,
      );
    }
  }
  for (const name of Object.keys(declared)) {
    if (!bound.has(name)) {
      problems.push(
        `The catalog manifest's resources.pipelines declares ${name}, but the Worker has no Pipelines binding by that name.`,
      );
    }
  }
  return problems;
}

/** A token permission as a catalog manifest's `tokenPermissions` lists it. */
interface PermissionEntry {
  name: string;
  description?: string;
  scope?: "account" | "zone" | "user";
}

/**
 * The permissions the token behind each sink's `tokenSecret` needs, in the
 * form of `tokenPermissions` entries, so the app's page lists them with the
 * token link like any token an app needs: R2 storage and R2 Data Catalog
 * write for the sink and the catalog's maintenance, R2 SQL read for the
 * queries apps of this kind make with the same token. One set per secret.
 * The dashboard's R2 API token with Admin Read & Write carries all three.
 */
export function pipelineTokenPermissions(
  pipelines: CatalogPipelines | undefined,
): PermissionEntry[] {
  const secrets = [...new Set(Object.values(pipelines ?? {}).map((p) => p.sink.tokenSecret))];
  return secrets.flatMap((secret): PermissionEntry[] => [
    {
      name: "Account.Workers R2 Storage:Edit",
      description: `In ${secret}: the Pipelines sink writes its files to R2 with it.`,
    },
    {
      name: "Account.Workers R2 Data Catalog:Edit",
      description: `In ${secret}: the sink writes its Iceberg table, and the catalog runs table maintenance, with it.`,
    },
    {
      name: "Account.Workers R2 SQL:Read",
      description: `In ${secret}: the app reads its tables with R2 SQL using the same token.`,
    },
  ]);
}

/**
 * Everything the app's page lists as the tokens an app needs: its catalog
 * manifest's `tokenPermissions`, then the permissions of each Pipelines sink
 * token ({@link pipelineTokenPermissions}) not already listed by name.
 */
export function appTokenPermissions<T extends PermissionEntry>(catalog: {
  tokenPermissions: readonly T[];
  resources?: { pipelines?: CatalogPipelines | undefined } | undefined;
}): Array<T | PermissionEntry> {
  const listed = new Set(catalog.tokenPermissions.map((p) => p.name.trim().toLowerCase()));
  const extra = pipelineTokenPermissions(catalog.resources?.pipelines).filter((p) => {
    const key = p.name.toLowerCase();
    if (listed.has(key)) return false;
    listed.add(key);
    return true;
  });
  return [...catalog.tokenPermissions, ...extra];
}

/** The parts of a catalog secret {@link pipelineManifestProblems} reads. */
interface SecretFacts {
  name: string;
  generate?: boolean | string | undefined;
  optional?: boolean | undefined;
  derive?: unknown;
  seedOnly?: boolean | undefined;
}

/**
 * What is wrong with a catalog manifest's `resources.pipelines` beyond its
 * shape: an app with a stream must say `plan: "paid"` and must not be a
 * self-deploying entry, and each sink's `tokenSecret` must name a secret the
 * install form asks the admin for. Paths are relative to the manifest.
 */
export function pipelineManifestProblems(manifest: {
  plan: string;
  install: { tier: string };
  secrets: readonly SecretFacts[];
  resources?: { pipelines?: CatalogPipelines | undefined } | undefined;
}): Array<{ path: Array<string | number>; message: string }> {
  const pipelines = manifest.resources?.pipelines;
  if (pipelines === undefined) return [];
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  if (manifest.install.tier === "self-deploying") {
    problems.push({
      path: ["resources", "pipelines"],
      message:
        "resources.pipelines is not allowed for the self-deploying tier: the app's own installer creates its streams",
    });
  }
  if (manifest.plan !== "paid") {
    problems.push({
      path: ["plan"],
      message:
        'an app with resources.pipelines needs "plan": "paid": Cloudflare offers Pipelines only on Workers Paid',
    });
  }
  const secrets = new Map(manifest.secrets.map((s) => [s.name, s]));
  for (const [binding, decl] of Object.entries(pipelines)) {
    const path = ["resources", "pipelines", binding, "sink", "tokenSecret"];
    const name = decl.sink.tokenSecret;
    const secret = secrets.get(name);
    if (secret === undefined) {
      problems.push({ path, message: `${name} is not one of the manifest's secrets` });
      continue;
    }
    if (
      (secret.generate !== undefined && secret.generate !== false) ||
      secret.optional === true ||
      secret.derive !== undefined ||
      secret.seedOnly === true
    ) {
      problems.push({
        path,
        message: `${name} holds the sink's Cloudflare API token, so the install form must ask for it: no generate, optional, derive or seedOnly`,
      });
    }
  }
  return problems;
}
