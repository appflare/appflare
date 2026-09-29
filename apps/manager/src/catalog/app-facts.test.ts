import { INDEX_ONLY_CATALOG_FIELDS } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { appFacts, NO_APP_FACTS } from "./app-facts";

describe("appFacts", () => {
  const row: Parameters<typeof appFacts>[0] = {
    tier: "artifact",
    services: ["kv", "r2", "a-service-added-later"],
    categories: ["utilities", "tabletop"],
    license: "MIT",
  };

  it("reads what the index row publishes", () => {
    expect(appFacts(row)).toEqual({
      primitives: { ids: ["kv", "r2"], complete: true, keyValueDurableObjects: false },
      categories: ["utilities", "tabletop"],
      appLicense: { expression: "MIT", note: null },
    });
  });

  it("carries the license note, and marks a tier that builds in the account as incomplete", () => {
    const facts = appFacts({
      ...row,
      tier: "sandbox",
      license: "BUSL-1.1",
      licenseNote: "Production use restricted.",
      keyValueDurableObjects: true,
    });
    expect(facts.appLicense).toEqual({
      expression: "BUSL-1.1",
      note: "Production use restricted.",
    });
    expect(facts.primitives.complete).toBe(false);
    expect(facts.primitives.keyValueDurableObjects).toBe(true);
  });

  it("covers every field only the index row carries", () => {
    // The list and app pages read these from the row, never from a manifest:
    // `authors` and `tagline` (the tile's line) directly, `licenseNote` here.
    // A field the schema adds to the list needs reading from the row too.
    expect([...INDEX_ONLY_CATALOG_FIELDS].sort()).toEqual(["authors", "licenseNote", "tagline"]);
  });

  it("knows nothing where no app is shown", () => {
    expect(NO_APP_FACTS).toEqual({
      primitives: { ids: [], complete: false, keyValueDurableObjects: false },
      categories: [],
      appLicense: null,
    });
  });
});
