import { describe, expect, it } from "vitest";
import type { ArtifactManifest } from "./artifact";
import { type CatalogManifest, catalogManifestSchema, catalogSecretSchema } from "./catalog";
import {
  catalogFieldChanges,
  catalogRevisionProblem,
  REVISABLE_CATALOG_FIELDS,
  requirementsRevisionProblem,
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

  it("accepts a revision that adds, changes or removes the access block", () => {
    const recommended = { mode: "recommended" as const, bypass: ["/s/*"] };
    expect(
      catalogRevisionProblem(released, { ...released, revision: 2, access: recommended }),
    ).toBe(null);
    const protectedRelease = { ...released, access: recommended };
    expect(
      catalogRevisionProblem(protectedRelease, {
        ...protectedRelease,
        revision: 2,
        access: { bypass: ["/s/*", "/api/webhook"] },
      }),
    ).toBeNull();
    const { access: _gone, ...withoutAccess } = protectedRelease;
    expect(catalogRevisionProblem(protectedRelease, { ...withoutAccess, revision: 2 })).toBeNull();
    expect(REVISABLE_CATALOG_FIELDS).toContain("access");
  });

  it("accepts a revision that adds or changes openPath or a field's link", () => {
    expect(REVISABLE_CATALOG_FIELDS).toContain("openPath");
    const linked = {
      ...released,
      revision: 2,
      openPath: "/dashboard",
      secrets: released.secrets.map((s) => ({
        ...s,
        link: { label: "Get a key", url: "https://example.com/keys" },
      })),
      vars: released.vars.map((v) => ({
        ...v,
        link: { label: "Which page", url: "https://example.com/docs" },
      })),
    };
    expect(catalogRevisionProblem(released, linked)).toBeNull();
    expect(
      catalogRevisionProblem(linked, { ...linked, revision: 3, openPath: "/admin/" }),
    ).toBeNull();
    const { openPath: _gone, ...withoutPath } = linked;
    expect(catalogRevisionProblem(linked, { ...withoutPath, revision: 3 })).toBeNull();
  });

  it("lets a revision give a key to a secret it adds, never to one already released", () => {
    const keys = { ...released, requires: ["secret-keys" as const] };
    const added = {
      ...keys,
      revision: 2,
      secrets: [
        ...released.secrets,
        { ...released.secrets[0], name: "CLIENT_ID", key: "GITHUB_CLIENT_ID", label: "GitHub" },
      ],
    } as CatalogManifest;
    expect(catalogRevisionProblem(released, added)).toBeNull();
    const rekeyed = {
      ...keys,
      revision: 2,
      secrets: [{ ...released.secrets[0], key: "OWNER_PASSWORD" }],
    } as CatalogManifest;
    expect(catalogRevisionProblem(released, rekeyed)).toBe(
      "it changes the key of the secret ADMIN_PASSWORD; a revision may give a key only to a secret it adds, and changing a released secret's key needs a new build",
    );
    // Taking a released key away is a change of key too.
    expect(
      catalogRevisionProblem({ ...rekeyed, revision: 1 }, { ...released, revision: 2 }),
    ).toMatch(/^it changes the key of the secret ADMIN_PASSWORD/);
  });

  it('accepts a revision that adds "access" to requires, and no other requirement change', () => {
    const required = catalogManifestSchema.parse({
      ...released,
      revision: 2,
      requires: ["access"],
      access: { mode: "required" },
    });
    expect(catalogRevisionProblem(released, required)).toBeNull();
    // With a var that reads the Access values, too.
    const withVar = catalogManifestSchema.parse({
      ...released,
      revision: 2,
      requires: ["access"],
      vars: [{ name: "ACCESS_TEAM", label: "Team", default: "{{accessTeamName}}" }],
    });
    expect(catalogRevisionProblem(released, withVar)).toBeNull();
    const r2 = { ...released, requires: ["r2" as const] };
    expect(
      catalogRevisionProblem(r2, { ...r2, revision: 2, requires: ["r2", "access"] }),
    ).toBeNull();
    // Order is not a change.
    expect(
      catalogRevisionProblem(
        { ...released, requires: ["r2", "access"] },
        { ...released, revision: 2, requires: ["access", "r2"] },
      ),
    ).toBeNull();
    expect(
      catalogRevisionProblem(released, { ...released, revision: 2, requires: ["access", "r2"] }),
    ).toBe(
      'it adds "r2" to requires; a revision may add only "access" or "secret-keys", and anything else needs a new build',
    );
    expect(catalogRevisionProblem(r2, { ...r2, revision: 2, requires: [] })).toBe(
      'it removes "r2" from requires, which only a new build can change',
    );
    // The signed Worker may read the Access values: "access" stays once released.
    const withAccess = { ...released, requires: ["access" as const] };
    expect(catalogRevisionProblem(withAccess, { ...withAccess, revision: 2, requires: [] })).toBe(
      'it removes "access" from requires, which only a new build can change',
    );
    expect(requirementsRevisionProblem(["zone"], ["zone", "access"])).toBeNull();
  });

  it('holds the revised manifest to the schema\'s "access" requirement rules', () => {
    // A revision is parsed like any catalog manifest, so one that uses an
    // Access placeholder or requires protection without listing "access"
    // never reaches the field comparison.
    for (const revised of [
      { ...released, revision: 2, access: { mode: "required" } },
      {
        ...released,
        revision: 2,
        vars: [{ name: "AUD", label: "Audience", default: "{{accessAud}}" }],
      },
    ]) {
      expect(catalogManifestSchema.safeParse(revised).success).toBe(false);
    }
  });

  it("refuses changes that only a new build can make, naming them", () => {
    const moved = {
      ...released,
      revision: 2,
      source: { ref: "v0.2.0", sha: "1".repeat(40) },
      install: { ...released.install, buildCommand: "pnpm build" },
      plan: "paid" as const,
    };
    expect(catalogRevisionProblem(released, moved)).toBe(
      "it changes install, plan, source, which only a new build can change",
    );
    for (const field of ["slug", "repo", "plan", "requires", "tokenPermissions"]) {
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
