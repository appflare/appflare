import type { ArtifactManifest, CatalogManifest } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { appFacts } from "./app-facts";

const catalog = {
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
    });
  });

  it("marks a list from a catalog manifest alone as incomplete", () => {
    const facts = appFacts({ tier: "self-deploying", requires: [] }, { catalog, manifest: null });
    expect(facts.primitives.complete).toBe(false);
    expect(facts.primitives.ids).toEqual(["email-routing", "zone"]);
  });
});
