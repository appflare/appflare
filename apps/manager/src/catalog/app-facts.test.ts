import type { ArtifactManifest, CatalogManifest } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { appFacts } from "./app-facts";

const catalog = {
  license: "BUSL-1.1",
  licenseNote: "Production use restricted.",
  requires: ["zone"],
  categories: ["email", "bots"],
  tokenPermissions: [],
  install: { tier: "artifact", emailRouting: { catchAll: true } },
} as unknown as CatalogManifest;

const manifest = {
  worker: {
    bindings: [
      { type: "d1", name: "DB" },
      { type: "r2_bucket", name: "BUCKET" },
      { type: "ai", name: "AI" },
    ],
    migrations: [],
    crons: ["0 3 * * *"],
  },
} as unknown as ArtifactManifest;

describe("appFacts", () => {
  it("knows only the index's requirements before a manifest is read", () => {
    expect(appFacts({ tier: "artifact", requires: ["r2"] }, null)).toEqual({
      primitives: { ids: ["r2"], complete: false, keyValueDurableObjects: false },
      categories: [],
      appLicense: null,
    });
  });

  it("reads bindings, crons, Email Routing and categories from an artifact (mail2telegram's shape)", () => {
    expect(appFacts({ tier: "artifact", requires: ["r2"] }, { catalog, manifest })).toEqual({
      primitives: {
        ids: ["d1", "r2", "cron", "workers-ai", "email-routing", "zone"],
        complete: true,
        keyValueDurableObjects: false,
      },
      categories: ["email", "bots"],
      appLicense: { expression: "BUSL-1.1", note: "Production use restricted." },
    });
  });

  it("marks a list from a catalog manifest alone as incomplete", () => {
    const facts = appFacts({ tier: "self-deploying", requires: [] }, { catalog, manifest: null });
    expect(facts.primitives.complete).toBe(false);
    expect(facts.primitives.ids).toEqual(["email-routing", "zone"]);
  });

  it("prefers what the index row publishes, with or without a manifest", () => {
    const row: Parameters<typeof appFacts>[0] = {
      tier: "artifact",
      requires: ["r2"],
      services: ["kv", "r2"],
      categories: ["utilities"],
      license: "MIT",
    };
    const expected = {
      primitives: { ids: ["kv", "r2"], complete: true, keyValueDurableObjects: false },
      categories: ["utilities"],
      appLicense: { expression: "MIT", note: null },
    };
    expect(appFacts(row, null)).toEqual(expected);
    expect(appFacts(row, { catalog, manifest })).toEqual(expected);
  });

  it("takes each fact the row lacks from the manifest", () => {
    const facts = appFacts(
      { tier: "artifact", requires: ["r2"], categories: ["storage"] },
      { catalog, manifest },
    );
    expect(facts.categories).toEqual(["storage"]);
    expect(facts.primitives.ids).toEqual([
      "d1",
      "r2",
      "cron",
      "workers-ai",
      "email-routing",
      "zone",
    ]);
    expect(
      appFacts({ tier: "artifact", requires: [], services: [] }, { catalog, manifest }).categories,
    ).toEqual(["email", "bots"]);
  });

  it("takes the license from the row, else from the catalog manifest", () => {
    const row: Parameters<typeof appFacts>[0] = {
      tier: "artifact",
      requires: [],
      license: "NONE",
    };
    expect(appFacts(row, { catalog, manifest }).appLicense).toEqual({
      expression: "NONE",
      note: null,
    });
    expect(appFacts({ tier: "artifact", requires: [] }, { catalog, manifest }).appLicense).toEqual({
      expression: "BUSL-1.1",
      note: "Production use restricted.",
    });
  });
});
