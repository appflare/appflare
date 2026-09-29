import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_IDS,
  catalogCategoriesSchema,
  catalogCategoryProblems,
  isCatalogCategory,
  MAX_ENTRY_CATEGORIES,
  strictCatalogCategoriesSchema,
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
    const labels = new Map<string, string>(CATALOG_CATEGORIES.map((c) => [c.id, c.label]));
    expect(labels.get("cms")).toBe("Websites and blogs");
    expect(labels.get("developer-tools")).toBe("Developer tools");
    for (const gone of ["social", "storage", "blogging", "gaming", "dns", "link-shortener"]) {
      expect(isCatalogCategory(gone), gone).toBe(false);
    }
  });
});

describe("catalogCategoriesSchema", () => {
  it("takes one to three plain strings, so a manager reads a category added later", () => {
    expect(MAX_ENTRY_CATEGORIES).toBe(3);
    for (const value of [["ai"], ["ai", "chat", "bots"], ["gardening"], ["ai", "ai"]]) {
      expect(catalogCategoriesSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
    for (const value of [[], [""], ["ai", "chat", "bots", "notes"], [1]]) {
      expect(catalogCategoriesSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("states the list in the JSON Schema, which describes what an author writes", () => {
    const json = z.toJSONSchema(catalogCategoriesSchema) as {
      uniqueItems?: boolean;
      items?: { enum?: string[] };
    };
    expect(json.uniqueItems).toBe(true);
    expect(json.items?.enum).toEqual([...CATALOG_CATEGORY_IDS]);
  });
});

describe("strictCatalogCategoriesSchema", () => {
  it("takes one to three known ids, each once", () => {
    expect(strictCatalogCategoriesSchema.safeParse(["ai"]).success).toBe(true);
    expect(strictCatalogCategoriesSchema.safeParse(["ai", "chat", "bots"]).success).toBe(true);
    for (const value of [[], ["ai", "ai"], ["ai", "chat", "bots", "notes"], ["AI"], ["social"]]) {
      expect(strictCatalogCategoriesSchema.safeParse(value).success, JSON.stringify(value)).toBe(
        false,
      );
    }
  });

  it("names the problem at its index", () => {
    expect(catalogCategoryProblems(["ai", "social", "ai"])).toEqual([
      { path: [1], message: expect.stringContaining('"social" is not a category') },
      { path: [2], message: 'the category "ai" is listed twice' },
    ]);
    expect(catalogCategoryProblems("ai")).toEqual([]);
  });
});
