import {
  CloudflareApiError,
  type CloudflareClient,
  R2_CATALOG_NOT_FOUND_CODE,
} from "@appflare/cf-api";
import type { StreamField } from "@appflare/schema";
import {
  PIPELINE_KIND,
  PIPELINE_SINK_KIND,
  PIPELINE_STREAM_KIND,
  R2_CATALOG_KIND,
} from "../../installs/resource-kinds";
import { errorMessage, isNotFound, JobError, type JobSteps } from "../steps";
import type { ResourceBindingPlan } from "./bindings";
import type { CreatedResource } from "./metadata";
import { recordResource } from "./phases";
import { explainR2Refusal } from "./r2-enablement";

/**
 * Setting up and removing what a Pipelines binding needs: a stream the
 * Worker sends events to, an R2 Data Catalog sink that writes them to an
 * Iceberg table, and the pass-through pipeline between them
 * (`INSERT INTO <sink> SELECT * FROM <stream>`), plus the sink's bucket when
 * no R2 binding of the app has it, and the bucket's Data Catalog.
 *
 * Two tokens are involved. The manager's own creates the bucket, the stream,
 * the sink and the pipeline (it needs Pipelines: Edit, an optional group of
 * the setup token). The catalog calls, and the sink itself, use the API token
 * the admin entered for the app (the secret the catalog manifest names in
 * `sink.tokenSecret`): Cloudflare keeps that token as the sink's credential
 * and the catalog's maintenance credential, so the manager's token is never
 * handed to another service, and it needs no R2 Data Catalog permission.
 *
 * Every create is a step of its own, followed by a step that records it, so
 * a retried create picks up what its own failed attempt made (found by name)
 * and a failed record never creates twice. Names already in the account are
 * never adopted.
 */

/** The token permission the manager's Pipelines calls need, in the dashboard's words. */
export const PIPELINES_PERMISSION = "Pipelines: Edit";

/**
 * Runs a call with the manager's token against the Pipelines API; a refusal
 * (401 or 403) ends the job with a sentence. Cloudflare answers 403 with
 * code 100 "Forbidden" both to a token without the permission and, as far as
 * the API says, to an account without Pipelines, so the sentence names both.
 */
export async function explainPipelinesRefusal<T>(
  call: () => Promise<T>,
  /** True when the account is known to be on Workers Paid: then only the permission can be missing. */
  accountPaid = false,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      const needs = accountPaid
        ? `The API token needs ${PIPELINES_PERMISSION}, an optional permission for apps that stream events into R2`
        : `The API token needs ${PIPELINES_PERMISSION}, an optional permission for apps that stream events into R2, and the account must be on Workers Paid, the only plan Pipelines is offered on`;
      throw new JobError(
        `Cloudflare refused the Pipelines call (${saidBy(error)}). ${needs}: add the permission to the token in the Cloudflare dashboard, then try again`,
      );
    }
    throw error;
  }
}

function saidBy(error: CloudflareApiError): string {
  return error.errors.map((e) => e.message).join("; ") || `HTTP ${error.status}`;
}

/**
 * Runs an R2 Data Catalog call made with the app's token; a refusal ends the
 * job naming the secret that holds the token and what it needs. The token's
 * value is never part of the sentence.
 */
async function explainCatalogTokenRefusal<T>(secret: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      throw new JobError(
        `Cloudflare refused the R2 Data Catalog call made with the token in ${secret} (${saidBy(error)}). That token needs Workers R2 Data Catalog: Edit and Workers R2 Storage: Edit on this account (an R2 API token with Admin Read & Write has both); create one, then uninstall this failed install and install again with it`,
      );
    }
    throw error;
  }
}

/** Step "check Pipelines": the cheapest Pipelines call, before anything is created. */
export async function checkPipelinesPhase(
  steps: JobSteps,
  opts: { accountPaid: boolean },
): Promise<void> {
  await steps.run("check Pipelines", async ({ log, cf }) => {
    await explainPipelinesRefusal(() => cf().pipelines.probeStreams(), opts.accountPaid);
    log.info("The API token can use Pipelines on this account.");
    return {};
  });
}

/**
 * Why the secrets entered for an install cannot set up its streams, one
 * sentence per stream: each sink needs the token its `tokenSecret` names.
 * Never repeats a value.
 */
export function pipelineTokenProblems(
  plans: readonly ResourceBindingPlan[],
  secrets: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const res of plans) {
    if (res.type !== "pipelines") continue;
    const secret = res.pipeline.declared.sink.tokenSecret;
    const value = Object.hasOwn(secrets, secret) ? secrets[secret] : undefined;
    if (value === undefined || value.trim().length === 0) {
      problems.push(
        `${secret} is required: it holds the API token the Pipelines sink of ${res.binding} writes to R2 with.`,
      );
    }
  }
  return problems;
}

/** The stream schema as the API takes it. */
function streamSchema(fields: readonly StreamField[]) {
  return {
    fields: fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.required === undefined ? {} : { required: f.required }),
      ...(f.unit === undefined ? {} : { unit: f.unit }),
    })),
  };
}

/** The pass-through SQL of a pipeline. Names are `[a-z0-9_]` and start with a letter. */
export function passThroughSql(sink: string, stream: string): string {
  return `INSERT INTO ${sink} SELECT * FROM ${stream}`;
}

/**
 * Creates and records everything of one Pipelines binding and returns the
 * stream as the upload binds it. `token` is the value of the secret the
 * sink's `tokenSecret` names, from the job's input: read inside the steps
 * that need it, never logged, returned, or recorded.
 */
export async function provisionPipelinePhase(
  steps: JobSteps,
  installId: string,
  res: Extract<ResourceBindingPlan, { type: "pipelines" }>,
  token: string,
): Promise<CreatedResource> {
  const { run } = steps;
  const plan = res.pipeline;
  const { bucket, declared } = plan;
  const secret = declared.sink.tokenSecret;
  const at = () => new Date(steps.now());

  await run(`check Pipelines names for ${res.binding}`, async ({ log, cf }) => {
    const api = cf();
    const taken: string[] = [];
    await explainPipelinesRefusal(async () => {
      if ((await api.pipelines.listStreams()).some((s) => s.name === plan.streamName)) {
        taken.push(`a Pipelines stream named ${plan.streamName}`);
      }
      if ((await api.pipelines.listSinks()).some((s) => s.name === plan.sinkName)) {
        taken.push(`a Pipelines sink named ${plan.sinkName}`);
      }
      if ((await api.pipelines.listPipelines()).some((p) => p.name === plan.pipelineName)) {
        taken.push(`a pipeline named ${plan.pipelineName}`);
      }
    });
    if (bucket.create) {
      const buckets = await explainR2Refusal(bucket.name, () =>
        api.r2.listBuckets({ nameContains: bucket.name }),
      );
      if (buckets.some((b) => b.name === bucket.name)) {
        taken.push(`an R2 bucket named ${bucket.name}`);
      }
    }
    if (taken.length > 0) {
      throw new JobError(
        `${taken.join(", ")} already exists in this account; Appflare does not adopt existing resources`,
      );
    }
    log.info(`No stream, sink, or pipeline named after ${res.binding} exists yet.`);
    return {};
  });

  if (bucket.create) {
    const made = await run(`create R2 bucket ${bucket.name}`, async ({ log, cf, attempt }) => {
      const api = cf();
      if (attempt > 1) {
        const buckets = await explainR2Refusal(bucket.name, () =>
          api.r2.listBuckets({ nameContains: bucket.name }),
        );
        if (buckets.some((b) => b.name === bucket.name)) {
          log.info(`Found the R2 bucket "${bucket.name}" an earlier attempt created.`);
          return { cfId: bucket.name };
        }
      }
      await explainR2Refusal(bucket.name, () => api.r2.createBucket({ name: bucket.name }));
      log.info(`Created R2 bucket "${bucket.name}" for the Pipelines sink of ${res.binding}.`);
      return { cfId: bucket.name };
    });
    await run(`record R2 bucket ${bucket.name}`, async ({ orm }) => {
      await recordResource(
        orm,
        installId,
        { kind: "r2", key: bucket.key, binding: null, name: bucket.name, cfId: made.cfId },
        at(),
      );
      return {};
    });
  }

  if (bucket.setUpCatalog) {
    const catalog = await run(
      `turn on R2 Data Catalog for ${bucket.name}`,
      async ({ log, cfAs, attempt }) => {
        const api = cfAs(token);
        return explainCatalogTokenRefusal(secret, async () => {
          let existing: { id: string; status?: string } | null = null;
          try {
            existing = await api.r2Catalog.get(bucket.name);
          } catch (error) {
            if (!isCatalogNotFound(error)) throw error;
          }
          if (existing !== null && attempt === 1) {
            // The bucket is this install's and new, so a catalog under its
            // name is what an earlier bucket of that name left behind; its
            // table records would stop the sink from creating its table.
            await api.r2Catalog.remove(bucket.name, { force: true });
            log.info(`Removed a Data Catalog an earlier bucket named "${bucket.name}" left.`);
            existing = null;
          }
          let id = existing?.id ?? null;
          if (existing === null || existing.status !== "active") {
            // `{ id, name }` (`r2-data-catalog_catalog-activation-response`).
            id = (await api.r2Catalog.enable(bucket.name))?.id ?? id;
          }
          log.info(`R2 Data Catalog is on for "${bucket.name}".`, { id });
          return { cfId: id ?? bucket.name };
        });
      },
    );
    await run(`record R2 Data Catalog ${bucket.name}`, async ({ orm }) => {
      await recordResource(
        orm,
        installId,
        {
          kind: R2_CATALOG_KIND,
          key: bucket.key,
          binding: null,
          name: bucket.name,
          cfId: catalog.cfId,
        },
        at(),
      );
      return {};
    });

    const { compaction, snapshotExpiration } = declared.sink;
    if (compaction === true || snapshotExpiration !== undefined) {
      await run(`turn on table maintenance for ${bucket.name}`, async ({ log, cfAs }) => {
        const api = cfAs(token);
        try {
          await explainCatalogTokenRefusal(secret, async () => {
            await api.r2Catalog.storeCredential(bucket.name, token);
            await api.r2Catalog.updateMaintenance(bucket.name, {
              ...(compaction === true ? { compaction: { state: "enabled" } } : {}),
              ...(snapshotExpiration === undefined
                ? {}
                : {
                    snapshot_expiration: {
                      state: "enabled",
                      max_snapshot_age: snapshotExpiration.maxAge,
                      ...(snapshotExpiration.minSnapshotsToKeep === undefined
                        ? {}
                        : { min_snapshots_to_keep: snapshotExpiration.minSnapshotsToKeep }),
                    },
                  }),
            });
          });
          log.info(
            `Table maintenance is on for "${bucket.name}": ${[
              compaction === true ? "compaction" : null,
              snapshotExpiration === undefined
                ? null
                : `snapshot expiration after ${snapshotExpiration.maxAge}`,
            ]
              .filter((s) => s !== null)
              .join(", ")}.`,
          );
        } catch (error) {
          // Maintenance keeps the table fast and small; the app works without
          // it, so a refusal is reported and the install goes on. Anything
          // that may pass on a retry (429, 5xx, the network) is retried.
          const refused =
            error instanceof JobError ||
            (error instanceof CloudflareApiError && error.status < 500 && error.status !== 429);
          if (!refused) throw error;
          log.warn(
            `Could not turn on table maintenance for "${bucket.name}" (${errorMessage(error)}); the table works without it. Turn it on in the Cloudflare dashboard under R2, ${bucket.name}, Data Catalog.`,
          );
        }
        return {};
      });
    }
  }

  const stream = await createAndRecord(steps, installId, {
    label: "Pipelines stream",
    name: plan.streamName,
    kind: PIPELINE_STREAM_KIND,
    key: res.binding,
    binding: res.binding,
    find: async (api) =>
      (await api.pipelines.listStreams()).find((s) => s.name === plan.streamName)?.id ?? null,
    create: async (api) =>
      (
        await api.pipelines.createStream({
          name: plan.streamName,
          format: { type: "json" },
          ...(declared.schema === undefined
            ? {}
            : { schema: streamSchema(declared.schema.fields) }),
          // Events reach the stream through the Worker's binding only.
          http: { enabled: false, authentication: false },
          worker_binding: { enabled: true },
        })
      ).id,
  });

  await createAndRecord(steps, installId, {
    label: "Pipelines sink",
    name: plan.sinkName,
    kind: PIPELINE_SINK_KIND,
    key: res.binding,
    binding: null,
    find: async (api) =>
      (await api.pipelines.listSinks()).find((s) => s.name === plan.sinkName)?.id ?? null,
    create: async (api) => {
      const { sink } = declared;
      try {
        return (
          await api.pipelines.createSink({
            name: plan.sinkName,
            type: "r2_data_catalog",
            format: {
              type: "parquet",
              ...(sink.compression === undefined ? {} : { compression: sink.compression }),
            },
            config: {
              account_id: steps.accountId(),
              bucket: bucket.name,
              namespace: sink.namespace,
              table_name: sink.table,
              token,
              ...(sink.rollIntervalSeconds === undefined
                ? {}
                : { rolling_policy: { interval_seconds: sink.rollIntervalSeconds } }),
            },
          })
        ).id;
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status < 500 && error.status !== 429) {
          throw new JobError(
            `Cloudflare could not create the sink of ${res.binding} (${saidBy(error)}). Check that the token in ${secret} has Workers R2 Data Catalog: Edit and Workers R2 Storage: Edit on this account, then uninstall this failed install and install again`,
          );
        }
        throw error;
      }
    },
  });

  await createAndRecord(steps, installId, {
    label: "pipeline",
    name: plan.pipelineName,
    kind: PIPELINE_KIND,
    key: res.binding,
    binding: null,
    find: async (api) =>
      (await api.pipelines.listPipelines()).find((p) => p.name === plan.pipelineName)?.id ?? null,
    create: async (api) =>
      (
        await api.pipelines.createPipeline({
          name: plan.pipelineName,
          sql: passThroughSql(plan.sinkName, plan.streamName),
        })
      ).id,
  });

  return { binding: res.binding, type: "pipelines", name: plan.streamName, cfId: stream };
}

/**
 * After a settings change gave a sink's `tokenSecret` a new value and the
 * version with it serves: stores the new token as the maintenance credential
 * of the bucket's catalog (where this stream set up maintenance), with that
 * token, and says that the sink keeps the token it was made with. The sink
 * is not recreated: Cloudflare cannot change a sink, and a new one cannot be
 * created for a table that already exists ("Sinks cannot be created for
 * existing Iceberg tables", developers.cloudflare.com/pipelines), so doing so
 * would leave the stream with no sink or drop the table. Never fails the
 * change, which already serves.
 */
export async function newSinkTokenPhase(
  steps: JobSteps,
  res: Extract<ResourceBindingPlan, { type: "pipelines" }>,
  token: string,
): Promise<void> {
  const { bucket, declared, sinkName } = res.pipeline;
  const secret = declared.sink.tokenSecret;
  const maintained =
    bucket.setUpCatalog &&
    (declared.sink.compaction === true || declared.sink.snapshotExpiration !== undefined);
  await steps.run(`use the new ${secret} for ${res.binding}`, async ({ log, cfAs }) => {
    if (maintained) {
      try {
        await explainCatalogTokenRefusal(secret, () =>
          cfAs(token).r2Catalog.storeCredential(bucket.name, token),
        );
        log.info(`Table maintenance of "${bucket.name}" now runs with the new ${secret}.`);
      } catch (error) {
        const refused =
          error instanceof JobError ||
          (error instanceof CloudflareApiError && error.status < 500 && error.status !== 429);
        if (!refused) throw error;
        log.warn(
          `Could not store the new ${secret} as the maintenance credential of "${bucket.name}" (${errorMessage(error)}); maintenance keeps the token it had.`,
        );
      }
    }
    log.warn(
      `The Pipelines sink "${sinkName}" keeps writing with the token it was created with: Cloudflare cannot change a sink, and a new sink cannot write to the existing table. Keep that token valid while the app is installed; revoking it stops new events from reaching the table.`,
    );
    return {};
  });
}

/** A create step, retried by name, and the step that records what it made. Returns its id. */
async function createAndRecord(
  steps: JobSteps,
  installId: string,
  what: {
    label: string;
    name: string;
    kind: typeof PIPELINE_STREAM_KIND | typeof PIPELINE_SINK_KIND | typeof PIPELINE_KIND;
    key: string;
    binding: string | null;
    find: (api: CloudflareClient) => Promise<string | null>;
    create: (api: CloudflareClient) => Promise<string>;
  },
): Promise<string> {
  const made = await steps.run(
    `create ${what.label} ${what.name}`,
    async ({ log, cf, attempt }) => {
      const api = cf();
      return explainPipelinesRefusal(async () => {
        // The check step saw no such name, so on a retry one is what this
        // step's own earlier attempt created before it failed.
        if (attempt > 1) {
          const existing = await what.find(api);
          if (existing !== null) {
            log.info(`Found the ${what.label} "${what.name}" an earlier attempt created.`, {
              id: existing,
            });
            return { cfId: existing };
          }
        }
        const cfId = await what.create(api);
        log.info(`Created ${what.label} "${what.name}".`, { id: cfId });
        return { cfId };
      });
    },
  );
  await steps.run(`record ${what.label} ${what.name}`, async ({ orm }) => {
    await recordResource(
      orm,
      installId,
      { kind: what.kind, key: what.key, binding: what.binding, name: what.name, cfId: made.cfId },
      new Date(steps.now()),
    );
    return {};
  });
  return made.cfId;
}

/** Whether a catalog call failed because the bucket has no catalog. */
export function isCatalogNotFound(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 404 || error.errors.some((e) => e.code === R2_CATALOG_NOT_FOUND_CODE))
  );
}

/** A recorded stream, sink or pipeline, deleted by id after the Worker. */
export interface PipelineTarget {
  id: string;
  kind: string;
  name: string;
  cfId: string | null;
}

const DELETE_LABEL: Record<string, string> = {
  [PIPELINE_KIND]: "pipeline",
  [PIPELINE_SINK_KIND]: "Pipelines sink",
  [PIPELINE_STREAM_KIND]: "Pipelines stream",
};

/** What steps and log lines call a stream, sink or pipeline. */
export function pipelineObjectLabel(kind: string): string {
  return DELETE_LABEL[kind] ?? kind;
}

/** The recorded streams, sinks and pipelines in the order they are deleted: pipelines, sinks, streams. */
export function pipelineTargets<T extends PipelineTarget>(rows: readonly T[]): T[] {
  const order = [PIPELINE_KIND, PIPELINE_SINK_KIND, PIPELINE_STREAM_KIND] as const;
  return order.flatMap((kind) => rows.filter((r) => r.kind === kind));
}

/**
 * Deletes one stream, sink or pipeline with the manager's token; a 404 means
 * it is gone already. Returns the log line.
 */
export async function deletePipelineObject(
  api: CloudflareClient,
  target: PipelineTarget,
): Promise<string> {
  const label = pipelineObjectLabel(target.kind);
  if (target.cfId === null) {
    return `No Cloudflare id is recorded for the ${label} "${target.name}", so it cannot be addressed; marked deleted without a call. Check the Cloudflare dashboard for it.`;
  }
  const id = target.cfId;
  try {
    await explainPipelinesRefusal(async () => {
      if (target.kind === PIPELINE_KIND) await api.pipelines.deletePipeline(id);
      else if (target.kind === PIPELINE_SINK_KIND) await api.pipelines.deleteSink(id);
      else await api.pipelines.deleteStream(id);
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return `The ${label} "${target.name}" was already gone.`;
  }
  return target.kind === PIPELINE_SINK_KIND
    ? `Deleted the ${label} "${target.name}"; what it wrote stays in its bucket.`
    : `Deleted the ${label} "${target.name}".`;
}

/**
 * Removes a bucket's Data Catalog, with its tables' records, before the
 * bucket is emptied and deleted, using the manager's token. The manager's
 * token may lack Workers R2 Data Catalog: Edit (no template can grant it), so
 * a refusal is a warning, not a failure: the bucket is still deleted, and
 * the next install that creates a bucket of this name clears the leftover
 * records with the app's own token. Returns the log line and its level.
 */
export async function removeBucketCatalog(
  api: CloudflareClient,
  bucket: string,
): Promise<{ level: "info" | "warn"; message: string }> {
  try {
    await api.r2Catalog.remove(bucket, { force: true });
    return { level: "info", message: `Removed the R2 Data Catalog of "${bucket}".` };
  } catch (error) {
    if (isCatalogNotFound(error)) {
      return { level: "info", message: `"${bucket}" has no R2 Data Catalog any more.` };
    }
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      return {
        level: "warn",
        message: `Cloudflare refused to remove the R2 Data Catalog of "${bucket}" (${saidBy(error)}); the bucket is deleted anyway. The catalog's records of its tables stay until a bucket named "${bucket}" is made again (a later install clears them then). Add Workers R2 Data Catalog: Edit to Appflare's token by hand to have uninstalls remove them.`,
      };
    }
    throw error;
  }
}
