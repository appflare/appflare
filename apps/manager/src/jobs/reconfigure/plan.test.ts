import { generateVapidPrivateKey } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  changedVarNames,
  connectionChangeProblems,
  databaseSlots,
  emailRouteZoneId,
  emailZones,
  enteredSecretProblems,
  nextStoredVars,
  parseStoredVars,
  replacementConfigName,
  secretChangeProblems,
  secretEnvPatch,
  secretSlots,
  secretVersionMessage,
  storedVarsJson,
} from "./plan";

const DECLARED = [
  {
    name: "ADMIN_PASSWORD",
    label: "Admin password",
    help: "Sign in.",
    generate: "password" as const,
  },
  { name: "API_KEY", label: "API key" },
  { name: "SMTP_PASSWORD", label: "SMTP password", optional: true },
];

describe("secret slots with a seed-only secret", () => {
  it("leaves it out: the install used it once and kept it nowhere", () => {
    const slots = secretSlots(
      [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
        {
          name: "FIRST_ADMIN_PASSWORD",
          label: "First admin",
          generate: "password",
          seedOnly: true,
        },
      ],
      ["ADMIN_PASSWORD"],
    );
    expect(slots.map((s) => s.name)).toEqual(["ADMIN_PASSWORD"]);
  });
});

describe("secret slots", () => {
  it("lists declared secrets first, then leftovers the version no longer declares", () => {
    expect(secretSlots(DECLARED, ["OLD_TOKEN", "ADMIN_PASSWORD"])).toEqual([
      {
        name: "ADMIN_PASSWORD",
        label: "Admin password",
        help: "Sign in.",
        generate: "password",
        declared: true,
        optional: false,
        present: true,
      },
      {
        name: "API_KEY",
        label: "API key",
        declared: true,
        optional: false,
        present: false,
      },
      {
        name: "SMTP_PASSWORD",
        label: "SMTP password",
        declared: true,
        optional: true,
        present: false,
      },
      {
        name: "OLD_TOKEN",
        label: "OLD_TOKEN",
        declared: false,
        optional: true,
        present: true,
      },
    ]);
  });
});

describe("databases elsewhere", () => {
  const declared = [
    { binding: "DB", protocol: "postgres" as const, help: "Postgres 15." },
    { binding: "LEGACY", protocol: "mysql" as const, label: "Old shop" },
  ];

  it("lists each declared database with the configuration its binding records", () => {
    expect(
      databaseSlots(declared, [
        { binding: "DB", name: "cut-db-r01abcdef" },
        { binding: null, name: "cut-db" },
      ]),
    ).toEqual([
      {
        binding: "DB",
        protocol: "postgres",
        help: "Postgres 15.",
        fieldLabel: "PostgreSQL connection string (DB)",
        configName: "cut-db-r01abcdef",
      },
      {
        binding: "LEGACY",
        protocol: "mysql",
        label: "Old shop",
        fieldLabel: "Old shop (LEGACY)",
        configName: null,
      },
    ]);
  });

  it("takes a valid string for a database with a configuration, and nothing else", () => {
    const slots = databaseSlots(declared, [
      { binding: "DB", name: "cut-db" },
      { binding: "LEGACY", name: "cut-legacy" },
    ]);
    expect(connectionChangeProblems({}, slots)).toEqual([]);
    expect(connectionChangeProblems({ DB: "postgres://u:p@h/db" }, slots)).toEqual([]);
    expect(connectionChangeProblems({ LEGACY: "postgres://u:secret@h/db" }, slots)).toEqual([
      "Old shop (LEGACY): This app needs a MySQL database: the connection string starts with mysql://.",
    ]);
    expect(connectionChangeProblems({ X: "postgres://u:p@h/db" }, slots)).toEqual([
      "X is not a database connection of this app.",
    ]);
    const unrecorded = databaseSlots(declared, []);
    expect(connectionChangeProblems({ DB: "postgres://u:p@h/db" }, unrecorded)).toEqual([
      "Appflare has no record of a Hyperdrive configuration for PostgreSQL connection string (DB); reinstall the app to connect it.",
    ]);
  });

  it("names a replacement after the configuration and the job, never growing", () => {
    // Named from the install's Worker and binding, whatever the current configuration is called.
    expect(replacementConfigName("cut", "DB", "01J8ZX4ABCDEFGH")).toBe("cut-db-rabcdefgh");
    expect(replacementConfigName("cut", "DB", "01J8ZX4ZYXWVUTS")).toBe("cut-db-rzyxwvuts");
    expect(replacementConfigName("app-rabcdefgh", "PG", "01J8ZX4ZYXWVUTS")).toBe(
      "app-rabcdefgh-pg-rzyxwvuts",
    );
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
    { name: "CF_PASSWORD", label: "Admin password" },
    {
      name: "CF_PASSWORD_HASH",
      label: "Admin password hash",
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

describe("a VAPID private key and the var derived from it", () => {
  const slots = secretSlots(
    [{ name: "VAPID_PRIVATE_KEY", label: "Push signing key", generate: "vapid-private-key" }],
    ["VAPID_PRIVATE_KEY"],
    [
      { name: "HOME" },
      {
        name: "VAPID_PUBLIC_KEY",
        derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
      },
    ],
  );

  it("name the var a new value replaces, and generate the key's kind", () => {
    expect(slots[0]).toMatchObject({
      generate: "vapid-private-key",
      derivesVars: ["VAPID_PUBLIC_KEY"],
    });
    expect(slots[0]?.derives).toBeUndefined();
  });

  it("take only a VAPID private key as its new value, never repeating what was typed", () => {
    expect(enteredSecretProblems({ VAPID_PRIVATE_KEY: generateVapidPrivateKey() }, slots)).toEqual(
      [],
    );
    const problems = enteredSecretProblems({ VAPID_PRIVATE_KEY: "hunter2" }, slots);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "Push signing key (VAPID_PRIVATE_KEY) must be a VAPID private key",
    );
    expect(problems[0]).not.toContain("hunter2");
    // An empty value is named by the change check instead.
    expect(enteredSecretProblems({ VAPID_PRIVATE_KEY: "" }, slots)).toEqual([]);
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
