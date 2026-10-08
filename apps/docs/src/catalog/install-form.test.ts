import { describe, expect, it } from "vitest";
import { installFormOf, needsWranglerVars, wranglerVarsOf } from "./install-form.ts";

const keyLink = { label: "Get a key", url: "https://example.com/keys" };

describe("installFormOf", () => {
  it("asks only for secrets that are neither generated, derived nor optional", () => {
    const form = installFormOf({
      secrets: [
        { name: "API_KEY", label: "API key", link: keyLink },
        { name: "PASSWORD", label: "Admin password", generate: "password" },
        { name: "HASH", label: "Password hash", derive: { from: "PASSWORD", method: "bcrypt" } },
        { name: "EXTRA", label: "Extra key", optional: true },
        { name: "SEED", label: "First password", seedOnly: true },
      ],
    });
    expect(form?.asks).toEqual([
      { label: "API key", link: keyLink, seedOnly: false },
      { label: "First password", link: null, seedOnly: true },
    ]);
    expect(form?.generated).toEqual(["Admin password"]);
    expect(form?.optional).toBe(1);
  });

  it("asks seed-only fields up front, optional or not, and never folds or counts them twice", () => {
    const form = installFormOf({
      secrets: [{ name: "GEN", label: "Generated", generate: "password", optional: true }],
      vars: [
        { name: "ADMIN", label: "Admin email", optional: true, seedOnly: true },
        { name: "LATER", label: "Later", optional: true },
      ],
    });
    expect(form?.asks).toEqual([{ label: "Admin email", link: null, seedOnly: true }]);
    expect(form?.generated).toEqual(["Generated"]);
    // Only "Later": the generated one is counted as generated, the seed-only one as asked.
    expect(form?.optional).toBe(1);
  });

  it("asks for a required setting only when nothing fills it in", () => {
    const vars = [
      { name: "DOMAIN", label: "Mail domain", default: "" },
      { name: "URL", label: "Public URL", default: "{{appUrl}}" },
      { name: "TITLE", label: "Site title" },
      { name: "MODE", label: "Mode" },
      { name: "COLOR", label: "Colour", type: "select", options: [{ value: "a" }, { value: "b" }] },
      { name: "AUD", label: "Access audience", derive: { from: "X", method: "vapid-public-key" } },
      { name: "NOTE", label: "Note", optional: true },
    ];
    const wrangler = new Map([
      ["TITLE", "My site"],
      ["MODE", "  "],
      ["COLOR", "c"],
    ]);
    expect(installFormOf({ vars }, { wrangler })?.asks.map((f) => f.label)).toEqual([
      "Mail domain",
      "Mode",
      "Colour",
    ]);
    // Without the wrangler config, a setting with no default counts as asked.
    expect(installFormOf({ vars })?.asks.map((f) => f.label)).toEqual([
      "Mail domain",
      "Site title",
      "Mode",
      "Colour",
    ]);
    expect(installFormOf({ vars })?.optional).toBe(1);
  });

  it("asks for each database's connection string and for an email domain", () => {
    const form = installFormOf({
      install: { tier: "artifact", emailRouting: { addresses: ["inbox"] } },
      secrets: [{ name: "K", label: "Key" }],
      resources: {
        hyperdrive: {
          DB: { protocol: "postgres", label: "Main database" },
          CACHE: { protocol: "mysql" },
        },
      },
      vars: [{ name: "V", label: "Setting", default: "" }],
    });
    expect(form?.asks.map((f) => f.label)).toEqual([
      "Key",
      "Main database (PostgreSQL connection string)",
      "MySQL connection string",
      "Setting",
    ]);
    expect(form?.databases).toEqual([
      "Main database (PostgreSQL connection string)",
      "MySQL connection string",
    ]);
    expect(form?.emailDomain).toBe(true);
    expect(installFormOf({})?.emailDomain).toBe(false);
  });

  it("says how the form offers Cloudflare Access and what stays public", () => {
    expect(installFormOf({})?.access).toBe("offered");
    expect(installFormOf({ access: { mode: "required" } })?.access).toBe("required");
    expect(installFormOf({ access: { mode: "recommended", bypass: ["/s/*"] } })).toMatchObject({
      access: "recommended",
      publicPaths: ["/s/*"],
    });
    // A mode this version does not know says nothing rather than something false.
    expect(installFormOf({ access: { mode: "someday", bypass: ["/s/*"] } })).toMatchObject({
      access: null,
      publicPaths: [],
    });
  });

  it("offers no Access for an app's own installer, by the index's tier first", () => {
    const required = { install: { tier: "artifact" }, access: { mode: "required" } };
    expect(installFormOf(required)?.access).toBe("required");
    expect(installFormOf(required, { tier: "self-deploying" })?.access).toBeNull();
    expect(
      installFormOf({ install: { tier: "self-deploying" }, access: { mode: "required" } })?.access,
    ).toBeNull();
  });

  it("counts the notes shown after the install", () => {
    const step = { type: "markdown", content: "Open {{appUrl}}." };
    expect(installFormOf({ postInstall: [step, step] })?.postInstallSteps).toBe(2);
    expect(installFormOf({ repo: "acme/cut" })).toEqual({
      asks: [],
      databases: [],
      emailDomain: false,
      generated: [],
      optional: 0,
      access: "offered",
      publicPaths: [],
      postInstallSteps: 0,
    });
  });

  it("leaves out a link that is not https, and refuses what is not a manifest", () => {
    const form = installFormOf({
      secrets: [{ name: "K", label: "Key", link: { label: "Get", url: "http://x.test" } }],
    });
    expect(form?.asks).toEqual([{ label: "Key", link: null, seedOnly: false }]);
    expect(installFormOf(undefined)).toBeNull();
    expect(installFormOf({ secrets: [{ name: "K" }] })).toBeNull();
  });
});

describe("the wrangler config's settings", () => {
  it("are read from a release's bindings, the primary Worker's first", () => {
    const release = {
      worker: {
        bindings: [
          { type: "plain_text", name: "TITLE", text: "Cut" },
          { type: "json", name: "LIST", json: ["a"] },
          { type: "kv_namespace", name: "KV" },
        ],
      },
      workers: [
        {
          worker: {
            bindings: [
              { type: "plain_text", name: "TITLE", text: "Other" },
              { type: "plain_text", name: "API", text: "x" },
            ],
          },
        },
      ],
    };
    expect(Object.fromEntries(wranglerVarsOf(release) ?? [])).toEqual({
      TITLE: "Cut",
      LIST: '["a"]',
      API: "x",
    });
    expect(wranglerVarsOf({ catalog: {} })).toBeNull();
  });

  it("are needed only for an asked setting without a default", () => {
    expect(needsWranglerVars({ vars: [{ name: "A", label: "A" }] })).toBe(true);
    expect(needsWranglerVars({ vars: [{ name: "A", label: "A", default: "" }] })).toBe(false);
    expect(needsWranglerVars({ vars: [{ name: "A", label: "A", optional: true }] })).toBe(false);
    expect(
      needsWranglerVars({ vars: [{ name: "A", label: "A", optional: true, seedOnly: true }] }),
    ).toBe(true);
    expect(needsWranglerVars({})).toBe(false);
  });
});
