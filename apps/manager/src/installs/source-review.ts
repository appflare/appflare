import {
  type ArtifactManifest,
  appServices,
  type RepositoryDetection,
  tooManyModulesMessage,
  type UNSUPPORTED_WRANGLER_SECTIONS,
} from "@appflare/schema";

type UnsupportedWranglerSection = (typeof UNSUPPORTED_WRANGLER_SECTIONS)[number];

import { planBindings } from "../jobs/install/bindings";
import { planQueueConsumers } from "../jobs/install/queue-consumers";

/**
 * What the review of a build from a repository (or from source) shows before
 * the admin installs or updates from it, worked out from the built artifact
 * manifest the way the install job will read it: the resources it creates,
 * the Cloudflare services it uses, and every reason the install would be
 * refused. The refusals are the install plan's own sentences (the catalog's
 * install check refuses the same bindings), so the review says exactly what
 * the job would. Pure, so the review page and the tests share it.
 */

/**
 * How the review names the wrangler config sections the packer does not
 * carry into the artifact (`UNSUPPORTED_WRANGLER_SECTIONS`).
 */
const UNSUPPORTED_SECTIONS: Readonly<Record<UnsupportedWranglerSection, string>> = {
  containers: "Containers",
  dispatch_namespaces: "dispatch namespaces (Workers for Platforms)",
  tail_consumers: "Tail Workers",
  pipelines: "Pipelines",
  secrets_store_secrets: "Secrets Store secrets",
  unsafe: "unsafe bindings",
  wasm_modules: "service-worker WebAssembly modules",
  text_blobs: "service-worker text blobs",
  data_blobs: "service-worker data blobs",
};

/** The sentence for a wrangler config section Appflare cannot install. */
export function unsupportedSectionProblem(section: string): string {
  const labels: Readonly<Record<string, string>> = UNSUPPORTED_SECTIONS;
  const label = labels[section] ?? section;
  return `The wrangler config declares ${label} (${section}), which Appflare cannot install yet.`;
}

/** The catalog `requires` value a sandbox tier manifest lists for its build. */
const BUILD_CONTAINER_REQUIREMENT = "containers";

/** Catalog `requires` values that follow from the services an app uses. */
const SERVICE_REQUIREMENTS: ReadonlyArray<readonly [string, string]> = [
  ["r2", "r2"],
  ["workers-ai", "workers-ai"],
  ["browser-rendering", "browser-rendering"],
  ["email-routing", "email-routing"],
];

export interface SourceReview {
  /** Resources the install creates, by binding. */
  creates: Array<{ kind: string; binding: string }>;
  durableObjects: string[];
  workflows: string[];
  /** Every binding of the Worker, as the manifest records it (vars included). */
  bindings: Array<{ type: string; name: string }>;
  crons: string[];
  /** The services the built Worker uses (the catalog's primitive ids). */
  services: string[];
  /**
   * What the account must offer to run it: the manifest's own `requires`
   * but the container it was built in, and those its bindings imply (an R2
   * bucket needs R2, and so on).
   */
  requires: string[];
  /** Why installing it would be refused; empty when it can be installed. */
  problems: string[];
}

/**
 * The review of `manifest`, as installing it under `workerName` would plan
 * it. `origin` is where the build came from: a repository's manifest is the
 * sandbox Worker's own work, which never sets up Email Routing, so one that
 * does was changed by the build and is refused.
 */
export function reviewBuild(
  manifest: Pick<ArtifactManifest, "worker" | "catalog">,
  detection: Pick<RepositoryDetection, "unsupported"> | null,
  workerName: string,
  origin: "repository" | "source" = "repository",
): SourceReview {
  const plan = planBindings(workerName, manifest.worker.bindings);
  const queues = planQueueConsumers(workerName, manifest.worker);
  const problems = [
    ...(detection?.unsupported ?? []).map(unsupportedSectionProblem),
    ...plan.problems,
    ...queues.problems,
  ];
  const tooMany = tooManyModulesMessage(manifest.worker.modules.length, "This build");
  if (tooMany !== null) problems.push(tooMany);
  if (origin === "repository" && manifest.catalog.install.emailRouting !== undefined) {
    problems.push(
      "The build's manifest sets up Email Routing, which Appflare does only for catalog apps.",
    );
  }
  const plain = new Set(
    manifest.worker.bindings
      .filter((b) => b.type === "plain_text" || b.type === "json")
      .map((b) => b.name),
  );
  for (const secret of manifest.catalog.secrets) {
    if (plain.has(secret.name)) {
      problems.push(
        `${secret.name} is both a secret and a plain var of the wrangler config; a Worker cannot have both. Remove it from one of them.`,
      );
    }
  }
  // A build's manifest is a sandbox tier one, whose `requires: containers`
  // (always there for a repository's) is the container the build ran in, not
  // something the built Worker runs: an installed Worker cannot declare
  // Containers (the packer refuses the section). What it runs on comes from
  // the built Worker's bindings, and any other requirement the catalog lists.
  const declared = manifest.catalog.requires.filter((r) => r !== BUILD_CONTAINER_REQUIREMENT);
  const services = appServices({ ...manifest.catalog, requires: declared }, manifest.worker).ids;
  const requires = [
    ...new Set([
      ...declared,
      ...SERVICE_REQUIREMENTS.filter(([service]) => (services as string[]).includes(service)).map(
        ([, requirement]) => requirement,
      ),
    ]),
  ];
  return {
    creates: [...plan.resources, ...queues.queues].map((r) => ({
      kind: r.kind,
      binding: r.binding,
    })),
    durableObjects: plan.durableObjects.map((d) => d.className),
    workflows: plan.workflows.map((w) => w.name),
    bindings: manifest.worker.bindings.map((b) => ({ type: b.type, name: b.name })),
    crons: [...new Set(manifest.worker.crons)],
    services,
    requires,
    problems,
  };
}

/**
 * How a build from source differs from the catalog's release of the app:
 * bindings the build has that the release does not, and the other way
 * round, as `type name`. Null when the catalog has no prebuilt release to
 * compare with (a sandbox tier app).
 */
export function bindingChanges(
  release: Pick<ArtifactManifest, "worker"> | null,
  built: Pick<ArtifactManifest, "worker">,
): { added: string[]; removed: string[] } | null {
  if (release === null) return null;
  const key = (b: { type: string; name: string }) => `${b.type} ${b.name}`;
  const before = new Set(release.worker.bindings.map(key));
  const after = new Set(built.worker.bindings.map(key));
  return {
    added: [...after].filter((k) => !before.has(k)),
    removed: [...before].filter((k) => !after.has(k)),
  };
}

/** The app slug an install from a repository is recorded under; never a catalog slug. */
export const REPOSITORY_SLUG_PREFIX = "repository:";

/**
 * `repository:<owner>/<repo>`: catalog slugs are `[a-z0-9-]` only, so an
 * install from a repository can never be taken for (or updated as) a catalog
 * app of the same name, whatever looks the catalog up by slug; and the owner
 * keeps two repositories of the same name apart.
 */
export function repositoryAppSlug(repo: string): string {
  return `${REPOSITORY_SLUG_PREFIX}${repo}`;
}

/** How logs name an install's app: a repository's without the prefix that keeps it apart. */
export function appSlugLabel(slug: string): string {
  return isRepositorySlug(slug) ? slug.slice(REPOSITORY_SLUG_PREFIX.length) : slug;
}

/** Whether an install's app slug is a repository's rather than a catalog app's. */
export function isRepositorySlug(slug: string): boolean {
  return slug.startsWith(REPOSITORY_SLUG_PREFIX);
}
