import { describe, expect, it } from "vitest";
import {
  appAlternativesSchema,
  appFeaturesSchema,
  MAX_APP_ALTERNATIVE_LENGTH,
  MAX_APP_FEATURE_LENGTH,
} from "./app-features";
import { catalogManifestSchema } from "./catalog";
import { INDEX_ONLY_CATALOG_FIELDS } from "./catalog-index";
import { REVISABLE_CATALOG_FIELDS } from "./revision";

const manifest = {
  slug: "beacon",
  name: "Beacon",
  summary: "Privacy-friendly web analytics on Workers.",
  tagline: "See who visits your site without cookies",
  repo: "acme/beacon",
  license: "MIT",
  categories: ["analytics"],
  source: { ref: "v1.0.0", sha: "0".repeat(40) },
  install: { tier: "artifact", packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
  plan: "free",
};

const features = [
  "See how many people visit your site and where they come from",
  "Count visits without cookies or a consent banner",
  "Share a public dashboard with your team",
];
const alternativeTo = ["Google Analytics", "Plausible", "Monday.com"];

/** Every message the manifest schema gives for `value`, as `path: message`. */
function problems(value: unknown): string[] {
  const result = catalogManifestSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("features and alternativeTo", () => {
  it("are optional, and kept as written when listed", () => {
    const without = catalogManifestSchema.parse(manifest);
    expect(without.features).toBeUndefined();
    expect(without.alternativeTo).toBeUndefined();
    const parsed = catalogManifestSchema.parse({ ...manifest, features, alternativeTo });
    expect(parsed.features).toEqual(features);
    expect(parsed.alternativeTo).toEqual(alternativeTo);
  });

  it("accept three to six features of up to the limit", () => {
    const six = [...features, "Keep the data in your own account", "Export it whenever", "Own it"];
    expect(appFeaturesSchema.safeParse(six).success).toBe(true);
    const longest = [...features.slice(0, 2), "a".repeat(MAX_APP_FEATURE_LENGTH)];
    expect(appFeaturesSchema.safeParse(longest).success).toBe(true);
  });

  it("refuse too few or too many features, saying how many", () => {
    expect(problems({ ...manifest, features: features.slice(0, 2) })).toEqual([
      "features: must list at least 3 features; leave it out to list none",
    ]);
    const seven = [...features, "Four", "Five", "Six", "Seven"];
    expect(problems({ ...manifest, features: seven })).toEqual([
      "features: must list at most 6 features",
    ]);
  });

  it("refuse a feature with a trailing period, padding, a line break or too many characters", () => {
    const at = (line: string) => problems({ ...manifest, features: [...features, line] });
    expect(at("Keep your data.")).toEqual(["features.3: must not end with a period"]);
    expect(at(" Keep your data")).toEqual([
      "features.3: must be one line without leading or trailing spaces",
    ]);
    expect(at("Keep your\ndata")).toEqual([
      "features.3: must be one line without leading or trailing spaces",
    ]);
    expect(at("a".repeat(MAX_APP_FEATURE_LENGTH + 1))).toEqual([
      "features.3: must be at most 100 characters",
    ]);
  });

  it("refuse a feature or an alternative listed twice, ignoring case", () => {
    const repeated = [...features, features[0]?.toUpperCase() ?? ""];
    expect(problems({ ...manifest, features: repeated })).toEqual([
      `features.3: "${repeated[3]}" is listed twice`,
    ]);
    expect(problems({ ...manifest, alternativeTo: ["Plausible", "plausible"] })).toEqual([
      'alternativeTo.1: "plausible" is listed twice',
    ]);
  });

  it("accept one to five alternatives of up to the limit", () => {
    expect(appAlternativesSchema.safeParse(["Plausible"]).success).toBe(true);
    expect(appAlternativesSchema.safeParse(["a".repeat(MAX_APP_ALTERNATIVE_LENGTH)]).success).toBe(
      true,
    );
    expect(problems({ ...manifest, alternativeTo: [] })).toEqual([
      "alternativeTo: must list at least 1 product; leave it out to list none",
    ]);
    expect(problems({ ...manifest, alternativeTo: ["A", "B", "C", "D", "E", "F"] })).toEqual([
      "alternativeTo: must list at most 5 products",
    ]);
  });

  it("refuse an alternative that is too long, padded, or a URL", () => {
    const at = (name: string) => problems({ ...manifest, alternativeTo: [name] });
    expect(at("a".repeat(MAX_APP_ALTERNATIVE_LENGTH + 1))).toEqual([
      "alternativeTo.0: must be at most 40 characters",
    ]);
    expect(at("Plausible ")).toEqual([
      "alternativeTo.0: must be one line without leading or trailing spaces",
    ]);
    for (const url of ["https://plausible.io", "www.plausible.io", "plausible.io/pricing"]) {
      expect(at(url), url).toEqual(["alternativeTo.0: must be a product's name, not a URL"]);
    }
  });

  it("need no revision: the index carries them, and a revision may carry a newer copy", () => {
    for (const field of ["features", "alternativeTo"]) {
      expect(INDEX_ONLY_CATALOG_FIELDS).toContain(field);
      expect(REVISABLE_CATALOG_FIELDS).toContain(field);
    }
  });
});
