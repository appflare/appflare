import { describe, expect, it } from "vitest";
import {
  appKey,
  catalogIdFromLabel,
  catalogIndexUrlSchema,
  customCatalogIdSchema,
  installAppKey,
  OFFICIAL_CATALOG_ID,
  parseAppKey,
  UNSIGNED_INDEX_REFUSAL,
  unsignedTierRefusal,
} from "./sources";

describe("app keys", () => {
  it("keeps the official catalog's plain slugs and namespaces a custom catalog's", () => {
    expect(appKey(OFFICIAL_CATALOG_ID, "cut")).toBe("cut");
    expect(appKey(null, "cut")).toBe("cut");
    expect(appKey("acme", "cut")).toBe("acme:cut");
    expect(parseAppKey("cut")).toEqual({ catalogId: OFFICIAL_CATALOG_ID, slug: "cut" });
    expect(parseAppKey("acme:cut")).toEqual({ catalogId: "acme", slug: "cut" });
  });

  it("round-trips, so the same slug in two catalogs stays two apps", () => {
    for (const [catalogId, slug] of [
      [OFFICIAL_CATALOG_ID, "cut"],
      ["acme", "cut"],
      ["acme-2", "open-seo"],
      [OFFICIAL_CATALOG_ID, "odd:slug"],
    ] as const) {
      expect(parseAppKey(appKey(catalogId, slug))).toEqual({ catalogId, slug });
    }
    expect(appKey("acme", "cut")).not.toBe(appKey(OFFICIAL_CATALOG_ID, "cut"));
  });

  it("never reads a repository install's slug as a catalog", () => {
    expect(parseAppKey("repository:owner/app")).toEqual({
      catalogId: OFFICIAL_CATALOG_ID,
      slug: "repository:owner/app",
    });
    expect(installAppKey({ app_slug: "repository:owner/app", catalog_id: null })).toBe(
      "repository:owner/app",
    );
    expect(installAppKey({ app_slug: "cut", catalog_id: "official" })).toBe("cut");
    expect(installAppKey({ app_slug: "cut", catalog_id: "acme" })).toBe("acme:cut");
  });
});

describe("catalog ids", () => {
  it("derives a free id from the label and never takes a reserved one", () => {
    expect(catalogIdFromLabel("Acme internal", new Set(["official"]))).toBe("acme-internal");
    expect(catalogIdFromLabel("Acme", new Set(["acme", "acme-2"]))).toBe("acme-3");
    expect(catalogIdFromLabel("Official", new Set(["official"]))).toBe("official-2");
    expect(catalogIdFromLabel("Repository", new Set())).toBe("repository-2");
    expect(catalogIdFromLabel("Café Apps!", new Set())).toBe("cafe-apps");
    expect(catalogIdFromLabel("***", new Set())).toBe("catalog");
    expect(customCatalogIdSchema.safeParse("official").success).toBe(false);
    expect(customCatalogIdSchema.safeParse("repository").success).toBe(false);
  });
});

describe("catalogIndexUrlSchema", () => {
  it("takes https URLs only, without credentials", () => {
    expect(catalogIndexUrlSchema.safeParse(" https://acme.test/index.json ").success).toBe(true);
    expect(catalogIndexUrlSchema.safeParse("http://acme.test/index.json").success).toBe(false);
    expect(catalogIndexUrlSchema.safeParse("https://user:pw@acme.test/index.json").success).toBe(
      false,
    );
    expect(catalogIndexUrlSchema.safeParse("acme.test/index.json").success).toBe(false);
  });
});

describe("unsignedTierRefusal", () => {
  it("refuses an added catalog's entries that are not prebuilt releases", () => {
    expect(unsignedTierRefusal("acme", "sandbox")).toBe(UNSIGNED_INDEX_REFUSAL);
    expect(unsignedTierRefusal("acme", "self-deploying")).toBe(UNSIGNED_INDEX_REFUSAL);
    expect(unsignedTierRefusal("acme", "artifact")).toBeNull();
    expect(unsignedTierRefusal("official", "sandbox")).toBeNull();
    expect(unsignedTierRefusal(null, "self-deploying")).toBeNull();
    expect(UNSIGNED_INDEX_REFUSAL).toBe(
      "This catalog's index is not signed; only prebuilt releases are installed from added catalogs.",
    );
  });
});
