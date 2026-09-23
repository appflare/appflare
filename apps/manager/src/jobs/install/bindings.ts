import {
  isVectorizeBinding,
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
 * A resource to create for a binding. A Vectorize index always carries the
 * dimensions and metric the artifact records, since Cloudflare cannot create
 * one without them.
 */
export type ResourceBindingPlan =
  | (ResourcePlanFields & { type: "vectorize"; vectorize: VectorizeIndexConfig })
  | (ResourcePlanFields & { type: Exclude<ResourceBindingType, "vectorize"> });

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
};

/**
 * Resource binding types created from the name alone. Vectorize is not one:
 * its plan needs the index shape, which only a parsed `VectorizeBinding` has.
 */
function isNamedResourceType(type: string): type is Exclude<ResourceBindingType, "vectorize"> {
  return type !== "vectorize" && Object.hasOwn(RESOURCE_BINDINGS, type);
}

/** Classifies every recorded binding; `problems` lists what blocks the install. */
export function planBindings(workerName: string, bindings: readonly WorkerBinding[]): BindingPlan {
  const plan: BindingPlan = { resources: [], durableObjects: [], workflows: [], problems: [] };
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
    } else if (isNamedResourceType(binding.type)) {
      addResource({
        binding: binding.name,
        type: binding.type,
        kind: RESOURCE_BINDINGS[binding.type],
        name: resourceName(workerName, binding.name),
      });
    } else if (binding.type === "durable_object_namespace") {
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
