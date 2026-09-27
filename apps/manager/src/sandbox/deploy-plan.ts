import type {
  ContainerApplication,
  ContainerApplicationConfiguration,
  ContainerRollout,
  CreateContainerApplicationArgs,
  CreateContainerRolloutArgs,
  DurableObjectNamespace,
  ModifyContainerApplicationArgs,
  ScriptMetadata,
  WorkerBinding,
} from "@appflare/cf-api";
import {
  type ArtifactManifest,
  SANDBOX_BUCKET_BINDING,
  SANDBOX_BUCKET_NAME,
  SANDBOX_CONTAINERS,
  SANDBOX_VERSION_METADATA_BINDING,
  SANDBOX_WORKER_NAME,
  type SandboxContainer,
  sandboxImage,
} from "@appflare/schema";

/**
 * The pure decisions of deploying the sandbox Worker through the Cloudflare
 * API alone, the way `wrangler deploy` 4.136.2 does it for a Worker with
 * `containers` and a Durable Object class per container
 * (`packages/deploy-helpers/src/deploy/deploy.ts`, `helpers/durable.ts`,
 * `helpers/container-metadata.ts` and `packages/containers-shared/src/deploy.ts`
 * in cloudflare/workers-sdk), proven live against a Workers Paid account:
 *
 * 1. `PUT /workers/scripts/appflare-sandbox` with the modules, the bindings,
 *    the Durable Object migrations still to apply, and `containers` naming
 *    each class's container application. Container Workers never use the
 *    versions API; the upload deploys at once and creates the namespaces.
 * 2. `workers.dev` and previews off: it is reached only through the
 *    manager's service binding.
 * 3. The namespace id of each class, from the uploaded version's bindings.
 * 4. Each container application: created when missing (its instances start
 *    at once, up to `max_instances`); when it runs another image or size,
 *    patched and then rolled out, since a patch alone never moves running
 *    instances to a new image.
 */

/** Cloudflare's code while a new version's bindings are not readable yet. */
export const VERSION_NOT_READY_CODE = 100146;

/** The Durable Object migrations to upload, given the Worker's current tag (wrangler's rule). */
export function migrationsToUpload(
  migrations: ArtifactManifest["worker"]["migrations"],
  currentTag: string | null,
): Record<string, unknown> | undefined {
  const last = migrations.at(-1);
  if (last === undefined) return undefined;
  const steps = (list: typeof migrations) => list.map(({ tag: _tag, ...rest }) => rest);
  if (currentTag === null) return { new_tag: last.tag, steps: steps(migrations) };
  const at = migrations.findIndex((m) => m.tag === currentTag);
  // A tag the release does not know: every migration, as wrangler does.
  if (at === -1) return { old_tag: currentTag, new_tag: last.tag, steps: steps(migrations) };
  if (at === migrations.length - 1) return undefined;
  return { old_tag: currentTag, new_tag: last.tag, steps: steps(migrations.slice(at + 1)) };
}

/**
 * The upload metadata of a verified sandbox Worker release (see
 * `verifySandboxManifest` for the bindings it may have). Secrets the sandbox
 * Worker holds (self-deploying apps' tokens) are kept. Throws for a release
 * without a main module, which `verifySandboxManifest` refuses already.
 */
export function sandboxScriptMetadata(
  manifest: ArtifactManifest,
  currentMigrationTag: string | null,
): ScriptMetadata {
  const mainModule = manifest.worker.mainModule;
  if (mainModule === undefined) {
    throw new Error("the sandbox Worker release has no Worker code (it serves static assets only)");
  }
  const hasVersionMetadata = manifest.worker.bindings.some(
    (b) => b.type === "version_metadata" && b.name === SANDBOX_VERSION_METADATA_BINDING,
  );
  const bindings: WorkerBinding[] = [
    ...SANDBOX_CONTAINERS.map((c) => ({
      type: "durable_object_namespace",
      name: c.class_name,
      class_name: c.class_name,
    })),
    { type: "r2_bucket", name: SANDBOX_BUCKET_BINDING, bucket_name: SANDBOX_BUCKET_NAME },
    { type: "plain_text", name: "APPFLARE_VERSION", text: manifest.version },
    ...(hasVersionMetadata
      ? [{ type: "version_metadata", name: SANDBOX_VERSION_METADATA_BINDING }]
      : []),
  ];
  const metadata: ScriptMetadata = {
    main_module: mainModule,
    compatibility_date: manifest.worker.compatibilityDate,
    compatibility_flags: [...manifest.worker.compatibilityFlags],
    bindings,
    keep_bindings: ["secret_text", "secret_key"],
    containers: SANDBOX_CONTAINERS.map((c) => ({ name: c.name, class_name: c.class_name })),
  };
  const migrations = migrationsToUpload(manifest.worker.migrations, currentMigrationTag);
  if (migrations !== undefined) metadata.migrations = migrations;
  if (manifest.worker.observability) {
    metadata.observability = manifest.worker.observability as ScriptMetadata["observability"];
  }
  return metadata;
}

/**
 * The namespace id of each container class, from a version's
 * `resources.bindings` (`GET /workers/scripts/<name>/versions/<id>`), then
 * from the account's namespace list for any class still missing. Null
 * entries were found in neither.
 */
export function containerNamespaces(
  versionBindings: unknown,
  namespaces: readonly DurableObjectNamespace[] = [],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const list = Array.isArray(versionBindings) ? versionBindings : [];
  for (const c of SANDBOX_CONTAINERS) {
    const bound = list.find(
      (b): b is Record<string, unknown> =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).type === "durable_object_namespace" &&
        (b as Record<string, unknown>).class_name === c.class_name,
    );
    const fromVersion = typeof bound?.namespace_id === "string" ? bound.namespace_id : null;
    const listed = namespaces.find(
      (n) => n.script === SANDBOX_WORKER_NAME && n.class === c.class_name,
    );
    out[c.class_name] = fromVersion ?? listed?.id ?? null;
  }
  return out;
}

/** Whether a deployed Worker's bindings are an Appflare sandbox Worker's (never touch another Worker by that name). */
export function isSandboxWorker(bindings: unknown): boolean {
  const list = Array.isArray(bindings) ? (bindings as Array<Record<string, unknown>>) : [];
  const has = (type: string, name: string) =>
    list.some((b) => typeof b === "object" && b !== null && b.type === type && b.name === name);
  return (
    has("durable_object_namespace", "Sandbox") &&
    has("r2_bucket", SANDBOX_BUCKET_BINDING) &&
    has("plain_text", "APPFLARE_VERSION")
  );
}

/** The `APPFLARE_VERSION` a sandbox Worker version reports in its bindings, or null. */
export function sandboxVersionOf(bindings: unknown): string | null {
  const list = Array.isArray(bindings) ? (bindings as Array<Record<string, unknown>>) : [];
  const found = list.find(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      b.type === "plain_text" &&
      b.name === "APPFLARE_VERSION",
  );
  return typeof found?.text === "string" ? found.text : null;
}

/** The configuration a container application runs for a sandbox Worker release. */
export function containerConfiguration(container: SandboxContainer, version: string) {
  return { image: sandboxImage(version), instance_type: container.instance_type };
}

/**
 * What Cloudflare expands each instance type to. An application is created
 * with `instance_type`, but `GET` answers with `vcpu`, `memory_mib` and
 * `disk.size_mb` instead (seen live on a Workers Paid account, 2026-09-24).
 */
const INSTANCE_SIZES: Readonly<
  Record<string, { vcpu: number; memory_mib: number; disk_mb: number }>
> = {
  "standard-1": { vcpu: 0.5, memory_mib: 4096, disk_mb: 8000 },
  "standard-2": { vcpu: 1, memory_mib: 6144, disk_mb: 12000 },
};

/**
 * Whether a configuration Cloudflare reports runs `image` on `instanceType`:
 * by `instance_type` when it names one, else by the size it expands to. A
 * size it does not report counts as the same, so an answer in a shape this
 * does not know never causes a rollout on its own.
 */
export function runsConfiguration(
  runs: ContainerApplicationConfiguration | undefined,
  target: { image: string; instance_type: string },
): boolean {
  if (runs?.image !== target.image) return false;
  if (typeof runs.instance_type === "string") return runs.instance_type === target.instance_type;
  const size = INSTANCE_SIZES[target.instance_type];
  const disk = (runs.disk as { size_mb?: unknown } | undefined)?.size_mb;
  if (size === undefined) return true;
  const differs = (reported: unknown, expected: number) =>
    typeof reported === "number" && reported !== expected;
  return !(
    differs(runs.vcpu, size.vcpu) ||
    differs(runs.memory_mib, size.memory_mib) ||
    differs(disk, size.disk_mb)
  );
}

/**
 * A new container application: exactly the body wrangler 4.136.2 sends for a
 * `containers` entry with a class and an instance type
 * (`getNormalizedContainerOptions` defaults: scheduling policy `default`,
 * tiers 1 and 2, grace period 0; `instances: 0` because Cloudflare replaced
 * it with `max_instances`). There is no pre-warm or minimum-instances field:
 * `max_instances` is only a cap. Cloudflare then prepares up to that many
 * instances (shown as `healthy` with `assigned` 0), which do not run and are
 * not billed; a Durable Object starts one when a build asks, and the sandbox
 * Worker stops it when the build ends (seen live on Workers Paid, 2026-09-24).
 */
export function containerApplicationBody(
  container: SandboxContainer,
  version: string,
  namespaceId: string,
  logs: boolean,
): CreateContainerApplicationArgs {
  return {
    name: container.name,
    scheduling_policy: "default",
    observability: { logs: { enabled: logs } },
    configuration: containerConfiguration(container, version),
    instances: 0,
    max_instances: container.max_instances,
    constraints: { tiers: [1, 2] },
    durable_objects: { namespace_id: namespaceId },
    rollout_active_grace_period: 0,
  };
}

/**
 * Rollout steps, as wrangler words them: all at once for one instance,
 * else a tenth first and then the rest.
 */
export function rolloutSteps(
  maxInstances: number,
): Pick<CreateContainerRolloutArgs, "step_percentage" | "steps"> {
  if (maxInstances < 2) return { step_percentage: 100 };
  const percentages = [10, 100];
  return {
    steps: percentages.map((percentage, i) => ({
      step_size: { percentage },
      description: `Step ${i + 1} of ${percentages.length} - rollout at ${percentage}% of instances`,
    })),
  };
}

/** What to do with one container application for a release. */
export type ContainerChange =
  | { kind: "create"; body: CreateContainerApplicationArgs }
  | { kind: "none" }
  /** A rollout to this release is already under way (an earlier attempt of the job). */
  | { kind: "wait-rollout"; rolloutId: string }
  | { kind: "patch"; modify: ModifyContainerApplicationArgs }
  | {
      kind: "rollout";
      modify: ModifyContainerApplicationArgs;
      rollout: CreateContainerRolloutArgs;
    }
  | { kind: "conflict"; message: string };

/**
 * Compares an existing application (and its active rollout, if any) with
 * what the release needs. An application bound to another namespace is not
 * Appflare's to change (wrangler refuses it the same way).
 */
export function containerChange(
  container: SandboxContainer,
  version: string,
  namespaceId: string,
  logs: boolean,
  existing: ContainerApplication | null,
  activeRollout: ContainerRollout | null = null,
): ContainerChange {
  if (existing === null) {
    return {
      kind: "create",
      body: containerApplicationBody(container, version, namespaceId, logs),
    };
  }
  const boundTo = existing.durable_objects?.namespace_id;
  if (boundTo !== undefined && boundTo !== namespaceId) {
    return {
      kind: "conflict",
      message: `the container application ${container.name} backs another Durable Object namespace (${boundTo}), not the sandbox Worker's ${container.class_name} (${namespaceId}); delete it in the Cloudflare dashboard (Workers > Containers), then try again`,
    };
  }
  const target = containerConfiguration(container, version);
  const sameImage = runsConfiguration(existing.configuration, target);
  const sameSize = existing.max_instances === container.max_instances;
  if (!sameImage) {
    if (activeRollout !== null && runsConfiguration(activeRollout.target_configuration, target)) {
      return { kind: "wait-rollout", rolloutId: activeRollout.id };
    }
    const modify: ModifyContainerApplicationArgs = {
      max_instances: container.max_instances,
      configuration: target,
    };
    return {
      kind: "rollout",
      modify,
      rollout: {
        description: "Progressive update",
        strategy: "rolling",
        kind: "full_auto",
        target_configuration: target,
        ...rolloutSteps(container.max_instances),
      },
    };
  }
  if (!sameSize) return { kind: "patch", modify: { max_instances: container.max_instances } };
  return { kind: "none" };
}

/** One application's state while the job waits for it. */
export interface ContainerWait {
  id: string;
  name: string;
  maxInstances: number;
  /** The rollout to wait for; null for a new application (or one that needed none). */
  rolloutId: string | null;
}

export interface ContainerProgress {
  settled: boolean;
  /** Why the wait cannot succeed any more; null while it can. */
  failure: string | null;
  /** One line for the job log. */
  summary: string;
}

/**
 * Whether an application is ready for builds: with a rollout, the rollout
 * completed; without one, every instance Cloudflare prepares for it (up to
 * `max_instances`) is healthy, or at least one is and none is still being
 * scheduled or starting. Failed instances are reported, and only fail the
 * wait when it runs out.
 */
export function containerProgress(
  wait: ContainerWait,
  app: ContainerApplication,
  rollout: ContainerRollout | null,
): ContainerProgress {
  const i = app.health?.instances ?? {};
  const healthy = i.healthy ?? 0;
  const pending = (i.starting ?? 0) + (i.scheduling ?? 0);
  const counts = `${healthy} healthy, ${i.starting ?? 0} starting, ${i.scheduling ?? 0} scheduling, ${i.failed ?? 0} failed of ${wait.maxInstances}`;
  if (wait.rolloutId !== null) {
    const status = rollout?.status ?? "unknown";
    if (status === "completed") {
      return {
        settled: true,
        failure: null,
        summary: `${wait.name}: rollout completed (${counts}).`,
      };
    }
    if (status === "reverted" || status === "replaced") {
      return {
        settled: false,
        failure: `the rollout of ${wait.name} was ${status}`,
        summary: `${wait.name}: rollout ${status} (${counts}).`,
      };
    }
    return {
      settled: false,
      failure: null,
      summary: `${wait.name}: rollout ${status} (${counts}).`,
    };
  }
  const settled = healthy >= wait.maxInstances || (healthy >= 1 && pending === 0);
  return { settled, failure: null, summary: `${wait.name}: ${counts}.` };
}
