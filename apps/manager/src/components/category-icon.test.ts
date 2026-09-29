import { CATALOG_CATEGORIES, categoryLabel } from "@appflare/schema/catalog-display";
import { describe, expect, it } from "vitest";
import { categoryIcon, FALLBACK_CATEGORY_ICON } from "./category-icon";

describe("catalog categories", () => {
  it.each(CATALOG_CATEGORIES.map((c) => [c.id, c.label] as const))(
    "gives %s an icon of its own and the schema's label %s",
    (id, label) => {
      expect(categoryIcon(id)).not.toBe(FALLBACK_CATEGORY_ICON);
      expect(categoryLabel(id)).toBe(label);
    },
  );

  it("gives every category a different icon", () => {
    const icons = CATALOG_CATEGORIES.map((c) => categoryIcon(c.id));
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("falls back for a category it does not know, such as a custom catalog's", () => {
    expect(categoryIcon("something-new")).toBe(FALLBACK_CATEGORY_ICON);
    expect(categoryLabel("something-new")).toBe("Something new");
    // A slug the catalog folded before its list was fixed is just unknown now.
    expect(categoryIcon("gaming")).toBe(FALLBACK_CATEGORY_ICON);
    expect(categoryLabel("gaming")).toBe("Gaming");
  });
});
