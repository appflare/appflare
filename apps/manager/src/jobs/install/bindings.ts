import type { WorkerBinding } from "@appflare/schema";

/**
 * How the install job treats each binding the packer recorded:
 * some need a backing resource created in the account, Durable Objects are
 * recorded for the resource checklist, the rest are sent as recorded.
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
 * carry no account-specific id (the packer strips ids by allowlist).
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
]);

export interface ResourceBindingPlan {
  binding: string;
  type: ResourceBindingType;
  kind: ProvisionedKind;
  /** `<workerName>-<binding>` (see {@link resourceName}). */
  name: string;
  /** Vectorize only: the index config from the recorded binding. */
  vectorize?: { dimensions: number; metric: "cosine" | "euclidean" | "dot-product" };
}

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

const VECTORIZE_METRICS = new Set(["cosine", "euclidean", "dot-product"]);

function vectorizeConfig(binding: WorkerBinding): ResourceBindingPlan["vectorize"] | undefined {
  const dimensions = binding.dimensions;
  const metric = binding.metric;
  if (
    typeof dimensions === "number" &&
    Number.isInteger(dimensions) &&
    dimensions > 0 &&
    typeof metric === "string" &&
    VECTORIZE_METRICS.has(metric)
  ) {
    return { dimensions, metric: metric as "cosine" | "euclidean" | "dot-product" };
  }
  return undefined;
}

function isResourceType(type: string): type is ResourceBindingType {
  return Object.hasOwn(RESOURCE_BINDINGS, type);
}

/** Classifies every recorded binding; `problems` lists what blocks the install. */
export function planBindings(workerName: string, bindings: readonly WorkerBinding[]): BindingPlan {
  const plan: BindingPlan = { resources: [], durableObjects: [], workflows: [], problems: [] };
  for (const binding of bindings) {
    if (isResourceType(binding.type)) {
      const kind = RESOURCE_BINDINGS[binding.type];
      const name = resourceName(workerName, binding.name);
      const entry: ResourceBindingPlan = { binding: binding.name, type: binding.type, kind, name };
      if (name.length > MAX_NAME_LENGTH[kind]) {
        plan.problems.push(
          `The ${kind} name "${name}" is longer than ${MAX_NAME_LENGTH[kind]} characters; choose a shorter Worker name.`,
        );
      }
      if (binding.type === "vectorize") {
        const config = vectorizeConfig(binding);
        if (config === undefined) {
          // TODO: have @appflare/pack record Vectorize dimensions and metric.
          plan.problems.push(
            `Vectorize binding ${binding.name}: the artifact does not record the index's dimensions and metric (@appflare/pack does not capture them yet), so Appflare cannot create the index. Apps with Vectorize bindings cannot be installed yet.`,
          );
        } else {
          entry.vectorize = config;
        }
      }
      plan.resources.push(entry);
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
    } else if (!PASSTHROUGH_BINDING_TYPES.has(binding.type)) {
      plan.problems.push(
        `Binding ${binding.name} has type "${binding.type}", which Appflare cannot install yet.`,
      );
    }
  }
  return plan;
}
