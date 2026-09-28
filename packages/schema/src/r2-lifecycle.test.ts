import { describe, expect, it } from "vitest";
import { workerBindingSchema } from "./artifact";
import { catalogManifestSchema } from "./catalog";
import {
  mergeR2LifecycleRules,
  r2LifecycleApiRule,
  undeclaredR2LifecycleRuleIds,
} from "./r2-lifecycle";

const manifest = {
  slug: "uploads",
  name: "Uploads",
  summary: "Share files.",
  tagline: "An app on Workers",
  homepage: "https://github.com/example/uploads",
  repo: "example/uploads",
  license: "MIT",
  categories: ["utilities"],
  maintainers: [],
  source: { ref: "main", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "npm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "uploads",
  },
  plan: "free",
  requires: [],
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

const withResources = (resources: Record<string, unknown>) =>
  catalogManifestSchema.safeParse({ ...manifest, resources });

describe("resources.r2 lifecycle rules", () => {
  it("parses rules with an age in days and an optional prefix", () => {
    const parsed = withResources({
      r2: {
        FILES: {
          lifecycle: [
            { id: "Delete temporary files", prefix: "tmp/", deleteAfterDays: 7 },
            { id: "archive", infrequentAccessAfterDays: 30, abortMultipartUploadsAfterDays: 1 },
          ],
        },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.resources?.r2?.FILES?.lifecycle).toHaveLength(2);
  });

  it("refuses a rule without an action, a repeated id, and ages outside 1 to 36500 days", () => {
    const refused = (rule: Record<string, unknown>) =>
      withResources({ r2: { FILES: { lifecycle: [rule] } } }).success;
    expect(refused({ id: "nothing" })).toBe(false);
    expect(refused({ id: "zero", deleteAfterDays: 0 })).toBe(false);
    expect(refused({ id: "forever", deleteAfterDays: 36_501 })).toBe(false);
    expect(refused({ id: "half", deleteAfterDays: 1.5 })).toBe(false);
    expect(refused({ id: "-starts-badly", deleteAfterDays: 1 })).toBe(false);
    // With "appflare:" before it, the id on the bucket stays within 64 characters.
    expect(refused({ id: "a".repeat(55), deleteAfterDays: 1 })).toBe(true);
    const long = withResources({
      r2: { FILES: { lifecycle: [{ id: "a".repeat(56), deleteAfterDays: 1 }] } },
    });
    expect(long.error?.issues[0]?.message).toBe(
      'a rule id is 1 to 55 letters, digits, spaces and . _ -, starting with a letter or digit (Appflare puts "appflare:" before it on the bucket)',
    );
    const twice = withResources({
      r2: {
        FILES: {
          lifecycle: [
            { id: "a", deleteAfterDays: 1 },
            { id: "a", deleteAfterDays: 2 },
          ],
        },
      },
    });
    expect(twice.error?.issues[0]?.message).toMatch(/the rule id "a" is used twice/);
    const cloudflares = withResources({
      r2: {
        FILES: { lifecycle: [{ id: "Default Multipart Abort Rule", deleteAfterDays: 1 }] },
      },
    });
    expect(cloudflares.error?.issues[0]?.message).toMatch(
      /^"Default Multipart Abort Rule" is the id of Cloudflare's own rule for unfinished multipart uploads, which Appflare keeps/,
    );
  });

  it("builds the API's rule the way wrangler does, ages in seconds", () => {
    expect(
      r2LifecycleApiRule({
        id: "all",
        deleteAfterDays: 2,
        infrequentAccessAfterDays: 1,
        abortMultipartUploadsAfterDays: 3,
      }),
    ).toEqual({
      id: "appflare:all",
      enabled: true,
      conditions: { prefix: "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 172_800 } },
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 259_200 } },
      storageClassTransitions: [
        { condition: { type: "Age", maxAge: 86_400 }, storageClass: "InfrequentAccess" },
      ],
    });
    expect(r2LifecycleApiRule({ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 })).toEqual({
      id: "appflare:tmp",
      enabled: true,
      conditions: { prefix: "tmp/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
    });
  });

  const defaultRule = {
    id: "Default Multipart Abort Rule",
    enabled: true,
    conditions: { prefix: "" },
    abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
  };

  it("keeps the bucket's own rules and replaces one of a declared id, so setting twice changes nothing", () => {
    const declared = [{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }];
    const once = mergeR2LifecycleRules([defaultRule], declared);
    expect(once).toEqual([defaultRule, r2LifecycleApiRule(declared[0] ?? { id: "x" })]);
    expect(mergeR2LifecycleRules(once, declared)).toEqual(once);
  });

  it("replaces only Appflare's own rules, where they stand, and never one added by hand", () => {
    // Someone added a rule by hand named like a declared one, and one of their own.
    const byHand = {
      id: "tmp",
      enabled: true,
      conditions: { prefix: "tmp/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 3_600 } },
    };
    const theirs = { ...byHand, id: "logs", conditions: { prefix: "logs/" } };
    const earlier = r2LifecycleApiRule({ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 });
    const dropped = r2LifecycleApiRule({ id: "old", deleteAfterDays: 9 });
    const declared = [
      { id: "tmp", prefix: "tmp/", deleteAfterDays: 3 },
      { id: "new", abortMultipartUploadsAfterDays: 2 },
    ];
    const merged = mergeR2LifecycleRules([defaultRule, earlier, byHand, dropped, theirs], declared);
    expect(merged).toEqual([
      defaultRule,
      r2LifecycleApiRule({ id: "tmp", prefix: "tmp/", deleteAfterDays: 3 }),
      byHand,
      dropped,
      theirs,
      r2LifecycleApiRule({ id: "new", abortMultipartUploadsAfterDays: 2 }),
    ]);
    expect(mergeR2LifecycleRules(merged, declared)).toEqual(merged);
    expect(undeclaredR2LifecycleRuleIds(merged, declared)).toEqual(["old"]);
    expect(undeclaredR2LifecycleRuleIds(merged, [])).toEqual(["tmp", "old", "new"]);
    expect(undeclaredR2LifecycleRuleIds([defaultRule, byHand, theirs], [])).toEqual([]);
  });

  it("is refused on a self-deploying entry", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...manifest,
      plan: "paid",
      install: {
        ...manifest.install,
        tier: "self-deploying",
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          workerNames: ["app-{{stage}}"],
        },
      },
      resources: { r2: { FILES: { lifecycle: [{ id: "a", deleteAfterDays: 1 }] } } },
    });
    expect(parsed.error?.issues.map((i) => i.message)).toContain(
      "resources.r2 is not allowed for the self-deploying tier: the app's own installer creates its buckets",
    );
  });
});

describe("resources.vectorize metadata indexes", () => {
  const index = { dimensions: 768, metric: "cosine" };

  it("are optional, typed, and each property is indexed once, at most ten", () => {
    const parsed = withResources({
      vectorize: {
        VECTORS: {
          ...index,
          metadataIndexes: [
            { propertyName: "url", type: "string" },
            { propertyName: "meta.year", type: "number" },
          ],
        },
      },
    });
    expect(parsed.data?.resources?.vectorize?.VECTORS?.metadataIndexes).toHaveLength(2);
    expect(withResources({ vectorize: { VECTORS: index } }).success).toBe(true);
    const bad = (metadataIndexes: unknown) =>
      withResources({ vectorize: { VECTORS: { ...index, metadataIndexes } } }).success;
    expect(bad([{ propertyName: "$id", type: "string" }])).toBe(false);
    expect(bad([{ propertyName: "a", type: "date" }])).toBe(false);
    expect(bad([])).toBe(false);
    expect(
      bad([
        { propertyName: "a", type: "string" },
        { propertyName: "a", type: "number" },
      ]),
    ).toBe(false);
    expect(
      bad(Array.from({ length: 11 }, (_, i) => ({ propertyName: `p${i}`, type: "string" }))),
    ).toBe(false);
  });
});

describe("artifact bindings and format", () => {
  it("record metadata indexes and lifecycle rules, and refuse malformed ones", () => {
    expect(
      workerBindingSchema.safeParse({
        type: "vectorize",
        name: "V",
        dimensions: 3,
        metric: "cosine",
        metadataIndexes: [{ propertyName: "url", type: "string" }],
      }).success,
    ).toBe(true);
    expect(
      workerBindingSchema.safeParse({
        type: "r2_bucket",
        name: "FILES",
        lifecycle: [{ id: "a", deleteAfterDays: 1 }],
      }).success,
    ).toBe(true);
    expect(workerBindingSchema.safeParse({ type: "r2_bucket", name: "FILES" }).success).toBe(true);
    expect(
      workerBindingSchema.safeParse({ type: "r2_bucket", name: "FILES", lifecycle: [{ id: "a" }] })
        .success,
    ).toBe(false);
  });
});
