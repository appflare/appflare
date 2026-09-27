import { describe, expect, it } from "vitest";
import { categoryLabel } from "../catalog/browse";
import { categoryIcon, FALLBACK_CATEGORY_ICON } from "./category-icon";

// Mirrors the categories of the live catalog index on 2026-09-27, each with the
// label its card shows. Add new categories here when the catalog gains them,
// with an icon and a label of their own.
const CATALOG_CATEGORIES: ReadonlyArray<readonly [slug: string, label: string]> = [
  ["ai", "AI"],
  ["analytics", "Analytics"],
  ["blogging", "Blogging"],
  ["bots", "Bots"],
  ["business", "Business"],
  ["chat", "Chat"],
  ["cms", "CMS"],
  ["community", "Community"],
  ["developer-tools", "Developer tools"],
  ["ecommerce", "E-commerce"],
  ["education", "Education"],
  ["email", "Email"],
  ["family", "Family"],
  ["files", "Files"],
  ["finance", "Finance"],
  ["games", "Games"],
  ["gaming", "Gaming"],
  ["marketing", "Marketing"],
  ["media", "Media"],
  ["monitoring", "Monitoring"],
  ["networking", "Networking"],
  ["notes", "Notes"],
  ["notifications", "Notifications"],
  ["passwords", "Passwords"],
  ["privacy", "Privacy"],
  ["productivity", "Productivity"],
  ["remote-access", "Remote access"],
  ["scheduling", "Scheduling"],
  ["security", "Security"],
  ["sharing", "Sharing"],
  ["social", "Social"],
  ["storage", "Storage"],
  ["sync", "Sync"],
  ["utilities", "Utilities"],
];

describe("catalog categories", () => {
  it.each(CATALOG_CATEGORIES)("gives %s an icon of its own and the label %s", (slug, label) => {
    expect(categoryIcon(slug)).not.toBe(FALLBACK_CATEGORY_ICON);
    expect(categoryLabel(slug)).toBe(label);
  });

  it("falls back for a category it does not know yet", () => {
    expect(categoryIcon("something-new")).toBe(FALLBACK_CATEGORY_ICON);
    expect(categoryLabel("something-new")).toBe("Something new");
  });
});
