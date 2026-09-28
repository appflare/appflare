import { describe, expect, it } from "vitest";
import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_IDS,
  catalogCategoriesSchema,
  categoryLabel,
  isCatalogCategory,
  MAX_ENTRY_CATEGORIES,
} from "./categories";

describe("the category list", () => {
  it("has 30 ids, each once, with a label", () => {
    expect(CATALOG_CATEGORIES).toHaveLength(30);
    expect(new Set(CATALOG_CATEGORY_IDS).size).toBe(30);
    for (const { id, label } of CATALOG_CATEGORIES) {
      expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(label.length).toBeGreaterThan(1);
    }
  });

  it("labels cms as websites and blogs, and has no merged-away ids", () => {
    expect(categoryLabel("cms")).toBe("Websites and blogs");
    expect(categoryLabel("developer-tools")).toBe("Developer tools");
    for (const gone of ["social", "storage", "blogging", "gaming", "dns", "link-shortener"]) {
      expect(isCatalogCategory(gone), gone).toBe(false);
      expect(categoryLabel(gone)).toBeNull();
    }
  });
});

describe("catalogCategoriesSchema", () => {
  it("takes one to three known ids, each once", () => {
    expect(MAX_ENTRY_CATEGORIES).toBe(3);
    expect(catalogCategoriesSchema.safeParse(["ai"]).success).toBe(true);
    expect(catalogCategoriesSchema.safeParse(["ai", "chat", "bots"]).success).toBe(true);
    for (const value of [[], ["ai", "ai"], ["ai", "chat", "bots", "notes"], ["AI"], ["social"]]) {
      expect(catalogCategoriesSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
