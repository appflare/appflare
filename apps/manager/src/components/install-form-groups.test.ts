import { describe, expect, it } from "vitest";
import type { InstallVarField } from "../installs/install-vars";
import { secretsOf } from "../test/artifact-fixture";
import {
  foldStartsOpen,
  foldSummary,
  foldsSecret,
  foldsVar,
  installFormGroups,
} from "./install-form-groups";

function field(over: Partial<InstallVarField> & { name: string }): InstallVarField {
  return {
    label: over.name,
    required: true,
    kind: "text",
    shownDefault: "",
    options: null,
    ...over,
  };
}

const secrets = secretsOf([
  { name: "API_KEY", label: "API key" },
  { name: "SESSION", label: "Session key", generate: "password" },
  { name: "OPENROUTER", label: "OpenRouter key", optional: true },
  { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password", seedOnly: true },
  {
    name: "PUBLIC_KEY",
    label: "Public key",
    derive: { from: "SESSION", method: "vapid-public-key" },
  },
]);

describe("which install fields fold", () => {
  it("asks up front for secrets the app must have, generated and seed-only ones included", () => {
    expect(foldsSecret({ optional: false, seedOnly: false })).toBe(false);
    expect(foldsSecret({ optional: true, seedOnly: false })).toBe(true);
    expect(foldsSecret({ optional: true, seedOnly: true })).toBe(false);
  });

  it("asks up front only for settings that are required and have no default", () => {
    expect(foldsVar(field({ name: "ORIGINS" }))).toBe(false);
    expect(foldsVar(field({ name: "MODE", shownDefault: "cloudflare_access" }))).toBe(true);
    expect(foldsVar(field({ name: "FOOTER", required: false }))).toBe(true);
    expect(foldsVar(field({ name: "PUBLIC", derivedFrom: "SESSION" }))).toBe(true);
    expect(foldsVar(field({ name: "ADMIN_EMAIL", required: false, seedOnly: true }))).toBe(false);
  });

  it("splits the form's fields in catalog order, leaving derived secrets out", () => {
    const vars = [field({ name: "ORIGINS" }), field({ name: "MODE", shownDefault: "a" })];
    const groups = installFormGroups(secrets, vars);
    expect(groups.needed.secrets.map((s) => s.name)).toEqual([
      "API_KEY",
      "SESSION",
      "ADMIN_PASSWORD",
    ]);
    expect(groups.folded.secrets.map((s) => s.name)).toEqual(["OPENROUTER"]);
    expect(groups.needed.vars.map((v) => v.name)).toEqual(["ORIGINS"]);
    expect(groups.folded.vars.map((v) => v.name)).toEqual(["MODE"]);
  });
});

describe("the fold of the install form", () => {
  const mode = field({ name: "MODE", shownDefault: "a" });
  const json = field({ name: "RULES", kind: "json", required: false });
  const closed = {
    secrets: {},
    vars: (f: InstallVarField) => f.shownDefault,
    varProblem: () => null,
  };

  it("starts closed when it holds only defaults", () => {
    expect(foldStartsOpen({ secrets: [{ name: "OPENROUTER" }], vars: [mode] }, closed)).toBe(false);
  });

  it("starts open when it holds a value, a changed setting, or one that cannot be used", () => {
    const folded = { secrets: [{ name: "OPENROUTER" }], vars: [mode, json] };
    expect(foldStartsOpen(folded, { ...closed, secrets: { OPENROUTER: "sk-1" } })).toBe(true);
    expect(foldStartsOpen(folded, { ...closed, vars: (f) => (f === mode ? "b" : "") })).toBe(true);
    expect(
      foldStartsOpen(folded, { ...closed, varProblem: (f) => (f === json ? "Not JSON." : null) }),
    ).toBe(true);
  });

  it("names its first fields while closed", () => {
    expect(foldSummary([])).toBe("");
    expect(foldSummary(["Name"])).toBe("Name");
    expect(foldSummary(["Name", "Key"])).toBe("Name and Key");
    expect(foldSummary(["A", "B", "C", "D"])).toBe("A, B, C and D");
    expect(foldSummary(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });
});
