import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureUrl, snapshotMode } from "./plugin.ts";
import { catalogSnapshotSchema, parseCatalogSnapshot } from "./snapshot.ts";

/** A fresh copy of the checked-in snapshot, to break. */
function fixture() {
  return JSON.parse(readFileSync(fixtureUrl, "utf8"));
}

function problems(value: unknown): string[] {
  const result = catalogSnapshotSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("the catalog snapshot", () => {
  it("accepts the checked-in fixture", () => {
    const snapshot = parseCatalogSnapshot(fixture(), "the fixture");
    expect(snapshot.index.apps.length).toBeGreaterThanOrEqual(6);
    expect(snapshot.index.apps.length).toBeLessThanOrEqual(8);
  });

  it("covers every part of the pages: icons, a cover with screenshots, an app with its own installer", () => {
    const { index } = parseCatalogSnapshot(fixture(), "the fixture");
    expect(index.apps.every((app) => app.media?.icon !== undefined)).toBe(true);
    expect(
      index.apps.some((app) => app.media?.cover !== undefined && app.media.screenshots.length > 0),
    ).toBe(true);
    expect(index.apps.some((app) => app.tier === "self-deploying")).toBe(true);
  });

  it("refuses a slug that is not the strict form", () => {
    for (const slug of ["Cut", "cut/../x", "-cut", "cut app", "a".repeat(64)]) {
      const value = fixture();
      const from = value.index.apps[0].slug;
      value.index.apps[0].slug = slug;
      value.links[slug] = value.links[from];
      delete value.links[from];
      expect(problems(value)).toContainEqual(
        expect.stringMatching(/^index\.apps\.0\.slug: .*slug/),
      );
    }
  });

  it("refuses a row missing a required field", () => {
    const value = fixture();
    delete value.index.apps[1].name;
    expect(problems(value)).toContainEqual(expect.stringMatching(/^index\.apps\.1\.name: /));
  });

  it("refuses a category that could not be a page address", () => {
    const value = fixture();
    value.index.apps[0].categories = ["email", "Big Tools"];
    expect(problems(value)).toEqual([
      'index.apps.0.categories.1: "Big Tools" is not a category id: lowercase letters, digits and dashes',
    ]);
  });

  it("refuses an app without its repository, links for an app it does not list, and a repeated slug", () => {
    const missing = fixture();
    const slug = missing.index.apps[0].slug;
    delete missing.links[slug];
    expect(problems(missing)).toContainEqual(
      `links.${slug}: no repository or homepage for "${slug}"`,
    );

    const extra = fixture();
    extra.links.ghost = { repo: "acme/ghost", homepage: "https://ghost.example" };
    expect(problems(extra)).toContainEqual('links.ghost: no app "ghost"');

    const twice = fixture();
    twice.index.apps.push(twice.index.apps[0]);
    expect(problems(twice)).toContainEqual(expect.stringMatching(/is listed twice/));
  });

  it("refuses a homepage that is not https", () => {
    const value = fixture();
    const slug = value.index.apps[0].slug;
    value.links[slug].homepage = "http://example.com";
    expect(problems(value)).toContainEqual(expect.stringMatching(/homepage: must be an https/));
  });

  it("names every problem when it refuses", () => {
    const value = fixture();
    delete value.index.apps[1].name;
    expect(() => parseCatalogSnapshot(value, "a test")).toThrow(
      /catalog snapshot from a test is not valid:\n {2}index\.apps\.1\.name/,
    );
  });
});

describe("snapshotMode", () => {
  it("fetches only when asked to, and refuses anything it does not know", () => {
    expect(snapshotMode(undefined)).toBe("fixture");
    expect(snapshotMode("")).toBe("fixture");
    expect(snapshotMode("fixture")).toBe("fixture");
    expect(snapshotMode("live")).toBe("live");
    expect(() => snapshotMode("yes")).toThrow(/CATALOG_SNAPSHOT/);
  });
});
