import { describe, expect, it } from "vitest";
import type { ArtifactManifest } from "./artifact";
import { type CatalogManifest, catalogManifestSchema, catalogSecretSchema } from "./catalog";
import {
  catalogFieldChanges,
  catalogRevisionProblem,
  REVISABLE_CATALOG_FIELDS,
  revisedArtifactProblem,
  withRevisedCatalog,
} from "./revision";

const released: CatalogManifest = catalogManifestSchema.parse({
  slug: "cut",
  name: "Cut",
  summary: "Self-hosted link shortener on Workers + KV.",
  tagline: "An app on Workers",
  homepage: "https://github.com/MendyLanda/cut",
  repo: "MendyLanda/cut",
  license: "MIT",
  categories: ["utilities"],
  maintainers: ["MendyLanda"],
  source: { ref: "v0.1.0", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "cut",
  },
  plan: "free",
  requires: [],
  secrets: [{ name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" }],
  vars: [{ name: "HOME_PAGE", label: "Home page", help: "default, 404, or admin" }],
  postInstall: [],
  tokenPermissions: [],
});

const selectVar = {
  name: "HOME_PAGE",
  label: "Home page",
  optional: false,
  seedOnly: false,
  type: "select" as const,
  options: [
    { value: "default", label: "Show the landing page" },
    { value: "404", label: "Return an empty 404 response" },
  ],
  default: "default",
};

describe("catalog manifest revision", () => {
  it("parses as a whole number from 1, and is 1 when omitted", () => {
    expect(released.revision).toBe(1);
    expect(catalogManifestSchema.parse({ ...released, revision: 3 }).revision).toBe(3);
    for (const bad of [0, -1, 1.5, "2"]) {
      expect(catalogManifestSchema.safeParse({ ...released, revision: bad }).success).toBe(false);
    }
  });

  it("lists the top-level fields that differ", () => {
    expect(catalogFieldChanges(released, { ...released })).toEqual([]);
    expect(
      catalogFieldChanges(released, { ...released, vars: [selectVar], revision: 2, name: "C" }),
    ).toEqual(["name", "revision", "vars"]);
    // Key order is not a change.
    const reordered = Object.fromEntries(Object.entries(released).reverse()) as CatalogManifest;
    expect(catalogFieldChanges(released, reordered)).toEqual([]);
  });

  it("accepts a higher revision that changes only the form and copy", () => {
    expect(
      catalogRevisionProblem(released, {
        ...released,
        revision: 2,
        vars: [selectVar],
        secrets: [
          ...released.secrets,
          catalogSecretSchema.parse({ name: "API_KEY", label: "API key" }),
        ],
        postInstall: [{ type: "markdown", content: "Open {{appUrl}}." }],
        summary: "A link shortener.",
        tagline: "An app on Workers",
      }),
    ).toBeNull();
  });

  it("refuses a revision that is not above the released one", () => {
    expect(catalogRevisionProblem(released, { ...released, vars: [selectVar] })).toMatch(
      /revision 1 is not above revision 1/,
    );
    expect(
      catalogRevisionProblem({ ...released, revision: 3 }, { ...released, revision: 2 }),
    ).toMatch(/revision 2 is not above revision 3/);
  });

  it("refuses changes that only a new build can make, naming them", () => {
    const moved = {
      ...released,
      revision: 2,
      source: { ref: "v0.2.0", sha: "1".repeat(40) },
      install: { ...released.install, buildCommand: "pnpm build" },
      requires: ["r2" as const],
    };
    expect(catalogRevisionProblem(released, moved)).toBe(
      "it changes install, requires, source, which only a new build can change",
    );
    for (const field of ["slug", "repo", "plan", "tokenPermissions"]) {
      expect(REVISABLE_CATALOG_FIELDS).not.toContain(field);
    }
  });

  it("holds a revised var to the artifact's Worker, and swaps only the catalog block", () => {
    const artifact = {
      catalog: released,
      worker: {
        bindings: [{ type: "json", name: "HOME_PAGE", json: 404 }],
      },
    } as unknown as ArtifactManifest;
    // The Worker reads HOME_PAGE as JSON, so every option must be JSON text.
    expect(
      revisedArtifactProblem(artifact, { ...released, revision: 2, vars: [selectVar] }),
    ).toMatch(/var HOME_PAGE is not valid JSON/);
    const revised = { ...released, revision: 2, name: "Cut links" };
    expect(revisedArtifactProblem(artifact, revised)).toBeNull();
    const effective = withRevisedCatalog(artifact, revised);
    expect(effective.catalog).toBe(revised);
    expect(effective.worker).toBe(artifact.worker);
  });
});
