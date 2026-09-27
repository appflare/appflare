import {
  type CatalogHyperdrive,
  type CatalogPipeline,
  type CatalogPipelines,
  entryWorkerRefName,
  type HyperdriveProtocol,
  hyperdriveDeclarationProblems,
  isVectorizeBinding,
  PIPELINES_BINDING_TYPE,
  pipelineDeclarationProblems,
  serviceBindingProblem,
  type VectorizeIndexConfig,
  type WorkerBinding,
} from "@appflare/schema";

/**
 * How the install job treats each binding the packer recorded:
 * some need a backing resource created in the account, Durable Objects are
 * recorded for the resource checklist, a service binding to the app's own
 * Worker is pointed at the install's Worker, the rest are sent as recorded.
 */

/** Binding types that need a backing resource, and the `resources.kind` they become. */
export const RESOURCE_BINDINGS = {
  kv_namespace: "kv",
  d1: "d1",
  r2_bucket: "r2",
  queue: "queue",
  vectorize: "vectorize",
  hyperdrive: "hyperdrive",
  // The binding's stream; its sink and pipeline are recorded without a binding.
  pipelines: "pipeline_stream",
} as const;

export type ResourceBindingType = keyof typeof RESOURCE_BINDINGS;
export type ProvisionedKind = (typeof RESOURCE_BINDINGS)[ResourceBindingType];

/**
 * Binding types sent to the upload exactly as the packer recorded them: they
 * carry no account-specific id (the packer strips ids by allowlist). Never
 * `service`: sent as recorded, one could name any Worker in the account.
 */
export const PASSTHROUGH_BINDING_TYPES: ReadonlySet<string> = new Set([
  "plain_text",
  "json",
  "durable_object_namespace",
  "ai",
  "browser",
  "version_metadata",
  "analytics_engine",
  "send_email",
  // A rate limit's `namespace_id` is replaced with the install's own id
  // (install/rate-limits.ts): counters are shared account-wide per id.
  "ratelimit",
  "images",
  // `{ type, name }` only. Workers Paid only: the artifact's catalog
  // manifest then says `plan: "paid"`, which the install and update gates ask for.
  "worker_loader",
]);

interface ResourcePlanFields {
  /** The binding, or for a resource no binding uses, the key it is recorded under. */
  binding: string;
  kind: ProvisionedKind;
  /** `<workerName>-<binding>` (see {@link resourceName}). */
  name: string;
  /**
   * True for a resource the Worker does not bind (a queue only a consumer
   * names): it is recorded without a binding.
   */
  unbound?: boolean;
}

/**
 * What a Pipelines binding gets: a stream (the binding's resource, `name`),
 * an R2 Data Catalog sink and the pipeline between them, named after the
 * binding with underscores (Pipelines names allow letters, digits and `_`
 * only), and the bucket the sink writes to.
 */
export interface PipelinePlan {
  streamName: string;
  sinkName: string;
  pipelineName: string;
  /** The catalog manifest's description of the stream and its sink. */
  declared: CatalogPipeline;
  bucket: {
    /** The R2 binding whose bucket it is, or the key a bucket of the stream's own is recorded under. */
    key: string;
    name: string;
    /**
     * True when no R2 binding has this bucket, so the stream's provisioning
     * creates it (unbound); only the first stream that names the key does.
     */
    create: boolean;
    /** True for the first stream that writes to this bucket: it turns the bucket's catalog on. */
    setUpCatalog: boolean;
  };
}

/**
 * A resource to create for a binding. A Vectorize index always carries the
 * dimensions and metric the artifact records, since Cloudflare cannot create
 * one without them. A Hyperdrive configuration carries the protocol the
 * catalog manifest declares; its origin comes from the connection string the
 * admin entered, which only the job's input holds. A Pipelines stream
 * carries the plan of its sink and pipeline; the sink's token comes from a
 * secret the admin entered.
 */
export type ResourceBindingPlan =
  | (ResourcePlanFields & { type: "vectorize"; vectorize: VectorizeIndexConfig })
  | (ResourcePlanFields & { type: "hyperdrive"; protocol: HyperdriveProtocol })
  | (ResourcePlanFields & { type: "pipelines"; pipeline: PipelinePlan })
  | (ResourcePlanFields & {
      type: Exclude<ResourceBindingType, "vectorize" | "hyperdrive" | "pipelines">;
    });

/**
 * A `workflow` binding. Workflow names are account-wide, and uploading a script
 * whose binding names another script's Workflow reassigns that Workflow to it
 * (wrangler warns "will reassign these workflows"). So the install renames each
 * one like any other resource, `<workerName>-<workflow_name>`, and checks the
 * name is free first.
 */
export interface WorkflowPlan {
  binding: string;
  /** The name the upload sends (`resourceName(workerName, workflow_name)`). */
  name: string;
  className: string;
}

export interface DurableObjectPlan {
  binding: string;
  className: string;
}

export interface BindingPlan {
  resources: ResourceBindingPlan[];
  durableObjects: DurableObjectPlan[];
  workflows: WorkflowPlan[];
  /** Human-readable reasons the artifact cannot be installed; empty when it can. */
  problems: string[];
}

/**
 * The name of a resource created for a binding: `<workerName>-<binding lowercased,
 * "_" -> "-">`. Characters no Cloudflare resource name allows
 * are dropped (binding names are JS identifiers, so only `$` in practice).
 */
export function resourceName(workerName: string, binding: string): string {
  const suffix = binding
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return `${workerName}-${suffix}`;
}

/** R2 bucket and queue names allow 3-63 of `[a-z0-9-]` (Vectorize: up to 64). */
const MAX_NAME_LENGTH: Record<ProvisionedKind, number> = {
  kv: 512,
  d1: 64,
  r2: 63,
  queue: 63,
  vectorize: 64,
  // Cloudflare allows 2048; the Worker name (at most 54) keeps these far shorter.
  hyperdrive: 2048,
  // Stream, sink and pipeline names allow 128.
  pipeline_stream: 128,
};

/**
 * The names of a Pipelines binding's stream, sink and pipeline:
 * `<workerName>_<binding lowercased>` with `_stream`, `_sink` and
 * `_pipeline`, every `-` as `_` (Pipelines names allow letters, digits and
 * underscores only).
 */
export function pipelineNames(
  workerName: string,
  binding: string,
): { stream: string; sink: string; pipeline: string } {
  const base = resourceName(workerName, binding).replace(/-/g, "_");
  return { stream: `${base}_stream`, sink: `${base}_sink`, pipeline: `${base}_pipeline` };
}

/**
 * Resource binding types created from the name alone. Vectorize is not one:
 * its plan needs the index shape, which only a parsed `VectorizeBinding` has;
 * nor is Hyperdrive, whose plan needs the protocol the catalog declares.
 */
function isNamedResourceType(
  type: string,
): type is Exclude<ResourceBindingType, "vectorize" | "hyperdrive" | "pipelines"> {
  return (
    type !== "vectorize" &&
    type !== "hyperdrive" &&
    type !== PIPELINES_BINDING_TYPE &&
    Object.hasOwn(RESOURCE_BINDINGS, type)
  );
}

/**
 * Classifies every recorded binding; `problems` lists what blocks the install.
 * `databases` is the catalog manifest's `resources.hyperdrive`: each
 * Hyperdrive binding must be declared there (the packer refuses one that is
 * not, and an artifact from before that rule is refused here). `streams` is
 * its `resources.pipelines`, which must describe each Pipelines binding the
 * same way.
 */
export function planBindings(
  workerName: string,
  bindings: readonly WorkerBinding[],
  databases: readonly CatalogHyperdrive[] = [],
  streams: CatalogPipelines = {},
): BindingPlan {
  const plan: BindingPlan = { resources: [], durableObjects: [], workflows: [], problems: [] };
  plan.problems.push(...hyperdriveDeclarationProblems(bindings, databases));
  plan.problems.push(...pipelineDeclarationProblems(bindings, streams));
  const protocols = new Map(databases.map((d) => [d.binding, d.protocol]));
  const r2Bindings = new Set(bindings.filter((b) => b.type === "r2_bucket").map((b) => b.name));
  /** Bucket keys an earlier stream of this plan already writes to. */
  const sinkBuckets = new Set<string>();
  const addResource = (entry: ResourceBindingPlan): void => {
    const limit = MAX_NAME_LENGTH[entry.kind];
    if (entry.name.length > limit) {
      plan.problems.push(
        `The ${entry.kind} name "${entry.name}" is longer than ${limit} characters; choose a shorter Worker name.`,
      );
    }
    plan.resources.push(entry);
  };
  for (const binding of bindings) {
    if (isVectorizeBinding(binding)) {
      // The artifact schema admits a Vectorize binding only with its index shape.
      addResource({
        binding: binding.name,
        type: "vectorize",
        kind: RESOURCE_BINDINGS.vectorize,
        name: resourceName(workerName, binding.name),
        vectorize: { dimensions: binding.dimensions, metric: binding.metric },
      });
    } else if (binding.type === "hyperdrive") {
      // An undeclared one is a problem above; it gets no configuration.
      const protocol = protocols.get(binding.name);
      if (protocol !== undefined) {
        addResource({
          binding: binding.name,
          type: "hyperdrive",
          kind: RESOURCE_BINDINGS.hyperdrive,
          name: resourceName(workerName, binding.name),
          protocol,
        });
      }
    } else if (binding.type === PIPELINES_BINDING_TYPE) {
      // An undescribed one is a problem above; it gets no stream.
      const declared = Object.hasOwn(streams, binding.name) ? streams[binding.name] : undefined;
      if (declared === undefined) continue;
      const names = pipelineNames(workerName, binding.name);
      // `_pipeline` is the longest suffix; stream, sink and pipeline names share the limit.
      if (names.pipeline.length > MAX_NAME_LENGTH.pipeline_stream) {
        plan.problems.push(
          `The pipeline name "${names.pipeline}" is longer than ${MAX_NAME_LENGTH.pipeline_stream} characters; choose a shorter Worker name.`,
        );
      }
      if (/^[0-9]/.test(names.stream)) {
        // The pipeline's SQL names the stream and the sink unquoted.
        plan.problems.push(
          `The Pipelines stream of ${binding.name} would be named "${names.stream}", and a pipeline's SQL cannot name a stream that starts with a digit; choose a Worker name that starts with a letter.`,
        );
      }
      const key = declared.sink.bucket;
      const bucketName = resourceName(workerName, key);
      const own = !r2Bindings.has(key);
      if (own && bucketName.length > MAX_NAME_LENGTH.r2) {
        plan.problems.push(
          `The r2 name "${bucketName}" is longer than ${MAX_NAME_LENGTH.r2} characters; choose a shorter Worker name.`,
        );
      }
      const first = !sinkBuckets.has(key);
      sinkBuckets.add(key);
      addResource({
        binding: binding.name,
        type: "pipelines",
        kind: RESOURCE_BINDINGS.pipelines,
        name: names.stream,
        pipeline: {
          streamName: names.stream,
          sinkName: names.sink,
          pipelineName: names.pipeline,
          declared,
          bucket: { key, name: bucketName, create: own && first, setUpCatalog: first },
        },
      });
    } else if (isNamedResourceType(binding.type)) {
      addResource({
        binding: binding.name,
        type: binding.type,
        kind: RESOURCE_BINDINGS[binding.type],
        name: resourceName(workerName, binding.name),
      });
    } else if (binding.type === "durable_object_namespace") {
      // A class in another Worker of the app: that Worker implements and
      // records it; the upload points the binding at its installed name.
      if (entryWorkerRefName(binding.script_name) !== null) continue;
      if (typeof binding.script_name === "string" && binding.script_name.length > 0) {
        plan.problems.push(
          `Durable Object binding ${binding.name} points at another Worker ("${binding.script_name}"); Appflare installs self-contained apps only.`,
        );
      }
      plan.durableObjects.push({
        binding: binding.name,
        className: typeof binding.class_name === "string" ? binding.class_name : binding.name,
      });
    } else if (binding.type === "workflow") {
      const upstream =
        typeof binding.workflow_name === "string" ? binding.workflow_name : binding.name;
      if (typeof binding.script_name === "string" && binding.script_name.length > 0) {
        plan.problems.push(
          `Workflow binding ${binding.name} points at another Worker ("${binding.script_name}"); Appflare installs self-contained apps only.`,
        );
      }
      const name = resourceName(workerName, upstream);
      if (name.length > 64) {
        plan.problems.push(
          `The Workflow name "${name}" is longer than 64 characters; choose a shorter Worker name.`,
        );
      }
      plan.workflows.push({
        binding: binding.name,
        name,
        className: typeof binding.class_name === "string" ? binding.class_name : binding.name,
      });
    } else if (binding.type === "service") {
      // Only a binding to the app's own Worker (`service: "self"`), which the
      // upload points at this install's Worker. Anything else could reach
      // another install or the manager's job units, which act with its
      // account-wide token, so it is refused however the artifact came to
      // hold it.
      const problem = serviceBindingProblem(binding);
      if (problem !== null) plan.problems.push(problem);
    } else if (!PASSTHROUGH_BINDING_TYPES.has(binding.type)) {
      plan.problems.push(
        `Binding ${binding.name} has type "${binding.type}", which Appflare cannot install yet.`,
      );
    }
  }
  return plan;
}
