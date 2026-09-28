import { describe, expect, it } from "vitest";
import { SERVICE_IDS } from "../services";
import { CATEGORY_IDS, canonicalCategory, categoryLabel } from "./categories";
import { PLAN_STATS, PLAN_WORDS } from "./plan";
import { declaredServices, SERVICE_NAMES, serviceName, serviceNeedWords } from "./services";
import { dateBuildDay } from "./versions";

describe("categories", () => {
  it("maps each folded category to the one it became", () => {
    expect(canonicalCategory("blogging")).toBe("cms");
    expect(canonicalCategory("gaming")).toBe("games");
    expect(canonicalCategory("social")).toBe("community");
    expect(canonicalCategory("storage")).toBe("files");
    expect(canonicalCategory("games")).toBe("games");
    expect(canonicalCategory("something-new")).toBe("something-new");
    // Not a property of every object.
    expect(canonicalCategory("constructor")).toBe("constructor");
  });

  it("labels slugs in sentence case, keeping acronyms", () => {
    expect(categoryLabel("ai")).toBe("AI");
    expect(categoryLabel("email")).toBe("Email");
    expect(categoryLabel("cms")).toBe("Websites and blogs");
    expect(categoryLabel("blogging")).toBe("Websites and blogs");
    expect(categoryLabel("link-shortener")).toBe("Link shortener");
    expect(categoryLabel("dns-tools")).toBe("DNS tools");
    expect(categoryLabel("toString")).toBe("ToString");
  });

  it("lists every labelled category once, and none of the folded ones", () => {
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
    for (const folded of ["blogging", "gaming", "social", "storage"]) {
      expect(CATEGORY_IDS).not.toContain(folded);
    }
    for (const id of CATEGORY_IDS) expect(canonicalCategory(id)).toBe(id);
  });
});

describe("plan wording", () => {
  it("has a short word for tiles and the full plan name for its tooltip", () => {
    expect(PLAN_WORDS.paid).toMatchObject({ word: "Paid", name: "Workers Paid" });
    expect(PLAN_WORDS.paid.tooltip).toContain("Workers Paid");
    expect(PLAN_WORDS.free).toMatchObject({ word: "Free", name: "Workers Free" });
    expect(PLAN_WORDS.free.tooltip).toContain("Workers Free");
  });

  it("names the plan in the stat strip with a sentence behind it", () => {
    expect(PLAN_STATS.paid.value).toBe("Workers Paid");
    expect(PLAN_STATS.free.tooltip).toMatch(/free Workers plan/);
  });
});

describe("services", () => {
  it("names every service", () => {
    for (const id of SERVICE_IDS) {
      expect(SERVICE_NAMES[id]).toMatch(/\S/);
      expect(serviceName(id)).toBe(SERVICE_NAMES[id]);
    }
    expect(serviceName("something-new")).toBeNull();
    expect(serviceName("constructor")).toBeNull();
  });

  it("says an app needs what its requires names, and uses what was worked out", () => {
    const declared = declaredServices(["r2", "zone", "something-new"]);
    expect([...declared].sort()).toEqual(["r2", "zone"]);
    expect(serviceNeedWords(declared.has("r2"))).toBe("This app needs it");
    expect(serviceNeedWords(declared.has("kv"))).toBe("This app uses it");
  });
});

describe("dateBuildDay", () => {
  it("reads the day of a date build and nothing else", () => {
    expect(dateBuildDay("0.0.0-20260921.4fd08b5")).toBe("2026-09-21");
    expect(dateBuildDay("0.0.0-20260231.4fd08b5")).toBeNull();
    expect(dateBuildDay("1.2.3")).toBeNull();
    expect(dateBuildDay("1.0.0-20260921.4fd08b5")).toBeNull();
  });
});
