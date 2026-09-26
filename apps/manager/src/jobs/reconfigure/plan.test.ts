import { describe, expect, it } from "vitest";
import {
  changedVarNames,
  emailRouteZoneId,
  emailZones,
  enteredSecretProblems,
  nextStoredVars,
  parseStoredVars,
  secretChangeProblems,
  secretEnvPatch,
  secretSlots,
  secretVersionMessage,
  storedVarsJson,
} from "./plan";

const DECLARED = [
  { name: "ADMIN_PASSWORD", label: "Admin password", help: "Sign in.", generate: true },
  { name: "API_KEY", label: "API key", generate: false },
  { name: "SMTP_PASSWORD", label: "SMTP password", generate: false, optional: true },
];

describe("secret slots", () => {
  it("lists declared secrets first, then leftovers the version no longer declares", () => {
    expect(secretSlots(DECLARED, ["OLD_TOKEN", "ADMIN_PASSWORD"])).toEqual([
      {
        name: "ADMIN_PASSWORD",
        label: "Admin password",
        help: "Sign in.",
        generate: true,
        declared: true,
        optional: false,
        present: true,
      },
      {
        name: "API_KEY",
        label: "API key",
        generate: false,
        declared: true,
        optional: false,
        present: false,
      },
      {
        name: "SMTP_PASSWORD",
        label: "SMTP password",
        generate: false,
        declared: true,
        optional: true,
        present: false,
      },
      {
        name: "OLD_TOKEN",
        label: "OLD_TOKEN",
        generate: false,
        declared: false,
        optional: true,
        present: true,
      },
    ]);
  });
});

describe("secret change problems", () => {
  const slots = secretSlots(DECLARED, ["ADMIN_PASSWORD", "API_KEY", "SMTP_PASSWORD", "OLD_TOKEN"]);

  it("allows replacing any secret and removing one the version does not need", () => {
    expect(
      secretChangeProblems({ set: { ADMIN_PASSWORD: "x", OLD_TOKEN: "y" }, unset: [] }, slots),
    ).toEqual([]);
    expect(secretChangeProblems({ set: {}, unset: ["OLD_TOKEN"] }, slots)).toEqual([]);
    expect(secretChangeProblems({ set: {}, unset: ["SMTP_PASSWORD"] }, slots)).toEqual([]);
  });

  it("sets an optional secret the Worker does not have yet, and removes it only once set", () => {
    const unset = secretSlots(DECLARED, ["ADMIN_PASSWORD", "API_KEY"]);
    expect(secretChangeProblems({ set: { SMTP_PASSWORD: "s" }, unset: [] }, unset)).toEqual([]);
    expect(secretChangeProblems({ set: {}, unset: ["SMTP_PASSWORD"] }, unset)).toEqual([
      "The app has no secret SMTP_PASSWORD to remove.",
    ]);
  });

  it("refuses unknown names, empty values, removing a declared secret, and both at once", () => {
    expect(
      secretChangeProblems(
        { set: { NOPE: "x", API_KEY: "", OLD_TOKEN: "z" }, unset: ["ADMIN_PASSWORD", "OLD_TOKEN"] },
        slots,
      ),
    ).toEqual([
      "NOPE is not a secret of this app.",
      "Enter a new value for API key (API_KEY), or leave it unchanged.",
      "Admin password (ADMIN_PASSWORD) is required by the installed version; it can be replaced, not removed.",
      "OLD_TOKEN cannot be replaced and removed at once.",
    ]);
    expect(secretChangeProblems({ set: {}, unset: ["GONE"] }, slots)).toEqual([
      "The app has no secret GONE to remove.",
    ]);
  });

  it("refuses every removal when the app's installer owns its secrets", () => {
    expect(
      secretChangeProblems({ set: {}, unset: ["OLD_TOKEN"] }, slots, { canRemove: false }),
    ).toEqual([
      "OLD_TOKEN cannot be removed here: the app's own installer sets its secrets on its Workers.",
    ]);
  });
});

describe("derived secrets in a settings change", () => {
  const declared = [
    { name: "CF_PASSWORD", label: "Admin password", generate: false },
    {
      name: "CF_PASSWORD_HASH",
      label: "Admin password hash",
      generate: false,
      derive: { from: "CF_PASSWORD", method: "bcrypt" as const },
    },
  ];
  const slots = secretSlots(declared, ["CF_PASSWORD", "CF_PASSWORD_HASH"]);

  it("mark the derived slot and the source it follows", () => {
    expect(slots.map((s) => [s.name, s.derivedFrom, s.derives])).toEqual([
      ["CF_PASSWORD", undefined, ["CF_PASSWORD_HASH"]],
      ["CF_PASSWORD_HASH", "CF_PASSWORD", undefined],
    ]);
  });

  it("refuse a derived secret entered on its own", () => {
    expect(enteredSecretProblems({ CF_PASSWORD_HASH: "$2b$10$x" }, slots)).toEqual([
      "CF_PASSWORD_HASH is computed from CF_PASSWORD; give CF_PASSWORD a new value instead.",
    ]);
    expect(enteredSecretProblems({ CF_PASSWORD: "new" }, slots)).toEqual([]);
  });

  it("change a source and what is derived from it together, or neither", () => {
    expect(
      secretChangeProblems(
        { set: { CF_PASSWORD: "new", CF_PASSWORD_HASH: "h" }, unset: [] },
        slots,
      ),
    ).toEqual([]);
    expect(secretChangeProblems({ set: { CF_PASSWORD: "new" }, unset: [] }, slots)).toEqual([
      "CF_PASSWORD_HASH is computed from CF_PASSWORD, so it must change with it.",
    ]);
    expect(secretChangeProblems({ set: { CF_PASSWORD_HASH: "h" }, unset: [] }, slots)).toEqual([
      "CF_PASSWORD_HASH is computed from CF_PASSWORD; give CF_PASSWORD a new value instead.",
    ]);
    expect(secretChangeProblems({ set: {}, unset: ["CF_PASSWORD_HASH"] }, slots)).toEqual([
      "Admin password hash (CF_PASSWORD_HASH) is required by the installed version; it can be replaced, not removed.",
    ]);
  });
});

describe("the secrets merge patch", () => {
  it("sets new values as secret_text bindings and removes with null", () => {
    expect(secretEnvPatch({ set: { A: "1" }, unset: ["B"] })).toEqual({
      A: { type: "secret_text", text: "1" },
      B: null,
    });
    expect(secretVersionMessage("job1")).toBe("Appflare: settings change job1");
  });
});

describe("stored settings", () => {
  it("keeps settings of other versions, replaces the version's own, and drops ones back at default", () => {
    const stored = { HOME_PAGE: "admin", LEGACY: "keep", TITLE: "Old" };
    expect(nextStoredVars(stored, ["HOME_PAGE", "TITLE"], { TITLE: " New " })).toEqual({
      LEGACY: "keep",
      TITLE: "New",
    });
    expect(changedVarNames(stored, { LEGACY: "keep", TITLE: "New" })).toEqual([
      "HOME_PAGE",
      "TITLE",
    ]);
    expect(changedVarNames(stored, { ...stored })).toEqual([]);
  });

  it("round-trips config_json, with null for none and {} read as none", () => {
    expect(storedVarsJson({})).toBeNull();
    expect(storedVarsJson({ b: "2", a: "1" })).toBe('{"a":"1","b":"2"}');
    expect(parseStoredVars('{"a":"1"}')).toEqual({ a: "1" });
    expect(parseStoredVars("{}")).toEqual({});
    expect(parseStoredVars(null)).toEqual({});
    expect(parseStoredVars("[1]")).toEqual({});
    expect(parseStoredVars("nope")).toEqual({});
  });
});

describe("the email zone of an install", () => {
  it("takes the zone of the newest record as current, whatever order the records come in", () => {
    const oldRoutes = [
      { name: "old.test", cfId: "routing:zone0", createdAt: 1 },
      { name: "hi@old.test", cfId: "rule:zone0:rule0", createdAt: 1 },
    ];
    const newRoutes = [
      { name: "odd", cfId: "unknown", createdAt: 9 },
      { name: "hello@example.com", cfId: "rule:zone1:rule1", createdAt: 5 },
    ];
    const expected = {
      current: { zoneId: "zone1", zoneName: "example.com" },
      leftover: [{ zoneId: "zone0", zoneName: "old.test" }],
    };
    expect(emailZones([...oldRoutes, ...newRoutes])).toEqual(expected);
    expect(emailZones([...newRoutes, ...oldRoutes])).toEqual(expected);
    // A tie goes to the later record.
    expect(
      emailZones([
        { name: "a.test", cfId: "routing:zoneA", createdAt: 3 },
        { name: "b.test", cfId: "routing:zoneB", createdAt: 3 },
      ]).current,
    ).toEqual({ zoneId: "zoneB", zoneName: "b.test" });
    expect(emailZones([])).toEqual({ current: null, leftover: [] });
    expect(emailRouteZoneId("catch_all:zone1")).toBe("zone1");
    expect(emailRouteZoneId("nope")).toBeNull();
  });
});
