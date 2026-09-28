import { categoryLabel } from "@appflare/schema/catalog-display";
import { describe, expect, it } from "vitest";
import { categoryIcon, FALLBACK_CATEGORY_ICON } from "./category-icon";

// Mirrors the categories of the live catalog index on 2026-09-27, each with the
// label its card shows. Add new categories here when the catalog gains them,
// with an icon and a label of their own. The live index is expected to stop
// using blogging, gaming, social and storage, folded into cms, games, community
// and files; they stay mapped, with their target's label and icon, so an older
// index or another catalog that still lists them renders fine.
const CATALOG_CATEGORIES: ReadonlyArray<readonly [slug: string, label: string]> = [
  ["ai", "AI"],
  ["analytics", "Analytics"],
  ["blogging", "Websites and blogs"],
  ["bots", "Bots"],
  ["business", "Business"],
  ["chat", "Chat"],
  ["cms", "Websites and blogs"],
  ["community", "Community"],
  ["developer-tools", "Developer tools"],
  ["ecommerce", "E-commerce"],
  ["education", "Education"],
  ["email", "Email"],
  ["family", "Family"],
  ["files", "Files"],
  ["finance", "Finance"],
  ["games", "Games"],
  ["gaming", "Games"],
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
  ["social", "Community"],
  ["storage", "Files"],
  ["sync", "Sync"],
  ["utilities", "Utilities"],
];

describe("catalog categories", () => {
  it.each(CATALOG_CATEGORIES)("gives %s an icon of its own and the label %s", (slug, label) => {
    expect(categoryIcon(slug)).not.toBe(FALLBACK_CATEGORY_ICON);
    expect(categoryLabel(slug)).toBe(label);
  });

  it.each([
    ["blogging", "cms"],
    ["gaming", "games"],
    ["social", "community"],
    ["storage", "files"],
  ])("shows the folded category %s as %s", (folded, target) => {
    expect(categoryIcon(folded)).toBe(categoryIcon(target));
    expect(categoryLabel(folded)).toBe(categoryLabel(target));
  });

  it("falls back for a category it does not know yet", () => {
    expect(categoryIcon("something-new")).toBe(FALLBACK_CATEGORY_ICON);
    expect(categoryLabel("something-new")).toBe("Something new");
  });
});
