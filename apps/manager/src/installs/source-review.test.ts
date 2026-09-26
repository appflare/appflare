import type { ArtifactManifest, WorkerBinding } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { planBindings } from "../jobs/install/bindings";
import { baseCatalog } from "../test/artifact-fixture";
import {
  bindingChanges,
  isRepositorySlug,
  repositoryAppSlug,
  reviewBuild,
  unsupportedSectionProblem,
} from "./source-review";

function manifest(
  bindings: WorkerBinding[],
  over: Partial<ArtifactManifest["worker"]> = {},
): ArtifactManifest {
  return {
    format: 1,
    app: "cut",
    version: "1.0.0",
    source: { repo: "MendyLanda/cut", sha: "a".repeat(40), ref: "main" },
    builtAt: "2026-09-01T00:00:00.000Z",
    builder: "@appflare/pack@0.0.0",
    keyId: "unsigned",
    assets: { config: {}, binding: null, files: [] },
    d1Migrations: {},
    worker: {
      name: "cut",
      mainModule: "index.js",
      compatibilityDate: "2026-09-01",
      compatibilityFlags: [],
      modules: [
        {
          name: "index.js",
          type: "esm" as const,
          path: "worker/index.js",
          size: 1,
          sha256: "a".repeat(64),
          offset: 0,
        },
      ],
      bindings,
      migrations: [],
      crons: [],
      observability: null,
      placement: null,
      limits: null,
      ...over,
    },
    catalog: baseCatalog({ install: { ...baseCatalog().install, tier: "sandbox" } }),
  };
}

describe("reviewBuild", () => {
  it("lists what the install creates and the services it uses", () => {
    const review = reviewBuild(
      manifest([
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "r2_bucket", name: "FILES" },
        { type: "ai", name: "AI" },
        { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
      ]),
      null,
      "cut",
    );
    expect(review.problems).toEqual([]);
    expect(review.creates).toEqual([
      { kind: "kv", binding: "CUT_KV" },
      { kind: "r2", binding: "FILES" },
    ]);
    expect(review.durableObjects).toEqual(["Room"]);
    expect(review.services).toEqual(
      expect.arrayContaining(["kv", "r2", "workers-ai", "durable-objects"]),
    );
    // The catalog manifest's own requirements, and those the bindings imply.
    expect(review.requires).toEqual(["r2", "workers-ai"]);
  });

  it("does not list Containers for the container the build ran in", () => {
    // A repository's manifest always requires Containers, for its build.
    const built = manifest([{ type: "kv_namespace", name: "CUT_KV" }]);
    const review = reviewBuild(
      { ...built, catalog: { ...built.catalog, plan: "paid", requires: ["containers"] } },
      null,
      "cut",
    );
    expect(review.services).toEqual(["kv"]);
    expect(review.requires).toEqual([]);
  });

  it("keeps the catalog's other requirements for a catalog app built from source", () => {
    const built = manifest([{ type: "r2_bucket", name: "FILES" }]);
    const review = reviewBuild(
      { ...built, catalog: { ...built.catalog, requires: ["containers", "zone"] } },
      null,
      "cut",
      "source",
    );
    expect(review.services).toEqual(expect.arrayContaining(["r2", "zone"]));
    expect(review.services).not.toContain("containers");
    expect(review.requires).toEqual(["zone", "r2"]);
  });

  it("refuses what the install would refuse, in the install plan's own words", () => {
    const bindings: WorkerBinding[] = [
      { type: "hyperdrive", name: "PG" },
      { type: "mtls_certificate", name: "CERT" },
      { type: "service", name: "OTHER", service: "billing" },
      { type: "durable_object_namespace", name: "SHARED", class_name: "S", script_name: "other" },
    ];
    const review = reviewBuild(manifest(bindings), { unsupported: ["containers"] }, "cut");
    const planned = planBindings("cut", bindings).problems;
    expect(planned.length).toBeGreaterThanOrEqual(4);
    expect(review.problems).toEqual([unsupportedSectionProblem("containers"), ...planned]);
    // A repository's manifest declares no databases, so its Hyperdrive binding is refused.
    expect(review.problems).toContain(
      "Hyperdrive binding PG is not declared in the catalog manifest's resources.hyperdrive, so Appflare does not know which database it connects to.",
    );
    expect(review.problems[0]).toBe(
      "The wrangler config declares Containers (containers), which Appflare cannot install yet.",
    );
  });

  it("refuses a secret that is also a plain var", () => {
    const review = reviewBuild(
      manifest([{ type: "plain_text", name: "ADMIN_PASSWORD", text: "" }]),
      null,
      "cut",
    );
    expect(review.problems).toEqual([
      "ADMIN_PASSWORD is both a secret and a plain var of the wrangler config; a Worker cannot have both. Remove it from one of them.",
    ]);
  });

  it("refuses Email Routing in a repository's manifest, which only the build could have put there", () => {
    const built = manifest([]);
    const withMail = {
      ...built,
      catalog: {
        ...built.catalog,
        install: { ...built.catalog.install, emailRouting: { catchAll: true } },
      },
    };
    expect(reviewBuild(withMail, null, "cut").problems).toEqual([
      "The build's manifest sets up Email Routing, which Appflare does only for catalog apps.",
    ]);
    expect(reviewBuild(withMail, null, "cut", "source").problems).toEqual([]);
  });
});

describe("bindingChanges", () => {
  it("says what a build from source adds and drops against the catalog's release", () => {
    const release = manifest([
      { type: "kv_namespace", name: "CUT_KV" },
      { type: "d1", name: "DB" },
    ]);
    const built = manifest([
      { type: "kv_namespace", name: "CUT_KV" },
      { type: "r2_bucket", name: "FILES" },
    ]);
    expect(bindingChanges(release, built)).toEqual({
      added: ["r2_bucket FILES"],
      removed: ["d1 DB"],
    });
    expect(bindingChanges(null, built)).toBeNull();
  });
});

describe("repositoryAppSlug", () => {
  it("can never be a catalog slug", () => {
    const slug = repositoryAppSlug("MendyLanda/cut");
    expect(slug).toBe("repository:MendyLanda/cut");
    // Two repositories of the same name stay apart.
    expect(repositoryAppSlug("someone/cut")).not.toBe(slug);
    expect(isRepositorySlug(slug)).toBe(true);
    expect(/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)).toBe(false);
    expect(isRepositorySlug("cut")).toBe(false);
  });
});
