import { describe, expect, it } from "vitest";
import {
  ADMINS_ONLY,
  type AppStatsInput,
  appLinks,
  appStats,
  descriptionParagraphs,
  headerAction,
  moduleBytes,
  provenance,
  settingsToChoose,
  shortDate,
  shortVersion,
} from "./app-page";
import type { CatalogSource } from "./sources";

const OFFICIAL: CatalogSource = {
  id: "official",
  label: "Appflare",
  colour: "orange",
  official: true,
};
const ACME: CatalogSource = { id: "acme", label: "Acme apps", colour: "blue", official: false };

const BASE: AppStatsInput = {
  plan: "free",
  version: "1.4.0",
  lastVerified: null,
  stars: null,
  installs: null,
  license: null,
  moduleBytes: null,
  categories: [],
  pin: null,
};
const UTC = { locale: "en-US", timeZone: "UTC", now: new Date("2026-09-27T12:00:00Z") };

function stat(input: Partial<AppStatsInput>, id: string) {
  return appStats({ ...BASE, ...input }, UTC).find((s) => s.id === id);
}

describe("the header's action", () => {
  it("is Install while the app is not installed", () => {
    expect(headerAction([], true, true)).toEqual({
      kind: "install",
      disabled: false,
      reason: null,
    });
  });

  it("is a disabled Install when the install form cannot be shown", () => {
    expect(headerAction([], false, true)).toEqual({
      kind: "install",
      disabled: true,
      reason: null,
    });
  });

  it("is a disabled Install that says why for a member", () => {
    const expected = { kind: "install", disabled: true, reason: "Only admins can install apps" };
    expect(headerAction([], true, false)).toEqual(expected);
    expect(headerAction([], false, false)).toEqual(expected);
    expect(ADMINS_ONLY).toBe("Only admins can install apps");
  });

  it("is still Manage for a member once installed, since members can look", () => {
    expect(headerAction([{ installId: "01ABC" }], true, false)).toMatchObject({
      kind: "manage",
      href: "/apps/01ABC",
    });
  });

  it("is Manage, linking to the install, once installed here", () => {
    expect(headerAction([{ installId: "01ABC" }], true, true)).toEqual({
      kind: "manage",
      href: "/apps/01ABC",
      count: 1,
    });
  });

  it("is Manage without a link when there are several installs to choose from", () => {
    expect(headerAction([{ installId: "a" }, { installId: "b" }], true, true)).toEqual({
      kind: "manage",
      href: null,
      count: 2,
    });
  });

  it("stays Manage even when another install is not possible", () => {
    expect(headerAction([{ installId: "a" }], false, true).kind).toBe("manage");
  });
});

describe("the description", () => {
  it("splits at blank lines and joins wrapped lines", () => {
    expect(descriptionParagraphs("One\nline.\n\n  Two.  \n\n\n")).toEqual(["One line.", "Two."]);
  });
});

describe("provenance", () => {
  it("names the catalog build, the account's own build, and a custom catalog", () => {
    expect(provenance(OFFICIAL, "artifact")).toMatchObject({
      kind: "catalog",
      label: "Catalog build",
    });
    expect(provenance(OFFICIAL, "sandbox")).toMatchObject({ kind: "yours", label: "Your build" });
    expect(provenance(OFFICIAL, "self-deploying")).toMatchObject({ label: "Your build" });
    expect(provenance(ACME, "artifact")).toMatchObject({
      kind: "custom",
      label: "Custom catalog: Acme apps",
    });
  });

  it("says a signature shows where a build came from, not that the code was reviewed", () => {
    expect(provenance(OFFICIAL, "artifact").tooltip).toContain("not a review of the code");
  });
});

describe("the stat strip", () => {
  it("keeps the order and leaves out stats with nothing to say", () => {
    expect(appStats(BASE, UTC).map((s) => s.id)).toEqual(["plan", "version", "tested"]);
    expect(
      appStats(
        {
          ...BASE,
          stars: 1234,
          license: { expression: "MIT", note: null },
          moduleBytes: 2048,
          categories: ["email"],
        },
        UTC,
      ).map((s) => s.id),
    ).toEqual(["stars", "plan", "license", "version", "size", "tested", "category"]);
  });

  it("shows sizes in human units with the exact count in the tooltip", () => {
    expect(stat({ moduleBytes: 999 }, "size")?.value).toBe("999 bytes");
    expect(stat({ moduleBytes: 48_213 }, "size")?.value).toBe("48.2 KB");
    expect(stat({ moduleBytes: 1_234_567 }, "size")?.value).toBe("1.2 MB");
    expect(stat({ moduleBytes: 1_234_567 }, "size")?.tooltip).toContain("1,234,567 bytes");
  });

  it("shows each kind of license", () => {
    expect(stat({ license: { expression: "MIT", note: null } }, "license")).toMatchObject({
      value: "MIT",
      caption: null,
      tone: "default",
    });
    expect(stat({ license: { expression: "BUSL-1.1", note: null } }, "license")).toMatchObject({
      value: "BUSL-1.1",
      caption: "Source-available",
      tone: "default",
    });
    const noted = stat({ license: { expression: "MIT", note: "No commercial use." } }, "license");
    expect(noted).toMatchObject({ caption: "Source-available", tooltip: "No commercial use." });
    expect(stat({ license: { expression: "NONE", note: null } }, "license")).toMatchObject({
      value: "No license",
      tone: "warning",
    });
    expect(
      stat({ license: { expression: "SEE LICENSE IN LICENSE.md", note: null } }, "license")?.value,
    ).toBe("Custom license");
  });

  it("dates the last test as a short day, with the year only when it is not this year's", () => {
    expect(stat({ lastVerified: "2026-09-26T03:10:00Z" }, "tested")?.value).toBe("Sep 26");
    expect(stat({ lastVerified: "2025-12-31T23:00:00Z" }, "tested")?.value).toBe("Dec 31, 2025");
    expect(stat({}, "tested")?.value).toBe("Not yet");
    expect(shortDate("2026-01-02T00:00:00Z", UTC)).toBe("Jan 2");
  });

  it("uses plain words for the plan, stars and category", () => {
    expect(stat({ plan: "free" }, "plan")?.value).toBe("Free");
    expect(stat({ plan: "paid" }, "plan")?.value).toBe("Workers Paid");
    expect(stat({ stars: 1234 }, "stars")?.value).toBe("1.2k");
    expect(stat({ categories: ["developer-tools", "ai"] }, "category")).toMatchObject({
      value: "Developer tools",
      tooltip: "Listed under Developer tools, AI.",
    });
  });

  it("shows installs after stars when the catalog publishes them", () => {
    const counts = (activeInstalls: number | null, installs30d: number | null) => ({
      activeInstalls,
      installs30d,
      installsKnown: true,
    });
    expect(stat({ installs: counts(2345, 10) }, "installs")?.value).toBe("2.3k");
    expect(stat({ installs: counts(null, 42) }, "installs")?.tooltip).toContain("last 30 days");
    expect(stat({ installs: counts(null, null) }, "installs")?.value).toBe("Under 10");
    expect(
      stat(
        { installs: { activeInstalls: null, installs30d: null, installsKnown: false } },
        "installs",
      ),
    ).toBeUndefined();
    expect(
      appStats({ ...BASE, stars: 5, installs: counts(20, null) }, UTC)
        .map((s) => s.id)
        .slice(0, 3),
    ).toEqual(["stars", "installs", "plan"]);
  });

  it("keeps the commit for the version's tooltip only", () => {
    const version = stat({ pin: "0123456789abcdef0123" }, "version");
    expect(version?.value).toBe("1.4.0");
    expect(version?.tooltip).toContain("0123456789ab");
  });

  it("shows a date build by its day, the full version in the tooltip", () => {
    const version = stat({ version: "0.0.0-20260921.4fd08b5" }, "version");
    expect(version?.value).toBe("Sep 21");
    expect(version?.tooltip).toContain("0.0.0-20260921.4fd08b5");
  });
});

describe("short versions", () => {
  it("names a date build by its day, in any time zone, with the year when it is not this year's", () => {
    expect(shortVersion("0.0.0-20260921.4fd08b5", UTC)).toEqual({ kind: "build", text: "Sep 21" });
    const behind = { ...UTC, timeZone: "America/Los_Angeles" };
    expect(shortVersion("0.0.0-20260921.4fd08b5", behind).text).toBe("Sep 21");
    expect(shortVersion("0.0.0-20251231.abc1234", UTC).text).toBe("Dec 31, 2025");
  });

  it("keeps a tagged version, and anything that is not a real day, as it is", () => {
    expect(shortVersion("1.2.3", UTC)).toEqual({ kind: "tagged", text: "1.2.3" });
    expect(shortVersion("0.0.0-20261345.4fd08b5", UTC).kind).toBe("tagged");
  });
});

describe("module bytes", () => {
  it("adds up every module of every Worker", () => {
    expect(
      moduleBytes([{ modules: [{ size: 10 }, { size: 5 }] }, { modules: [{ size: 1 }] }]),
    ).toBe(16);
    expect(moduleBytes([{ modules: [] }])).toBe(0);
  });
});

describe("settings you will choose", () => {
  it("lists secrets then settings by label, leaving out derived values", () => {
    const items = settingsToChoose(
      [
        {
          name: "ADMIN_PASSWORD",
          label: "Admin password",
          help: "Signs you in to the app.",
          optional: false,
        },
        { name: "SESSION_KEY", label: "Session key", generate: "password", optional: false },
        { name: "SMTP_TOKEN", label: "Mail token", optional: true },
        {
          name: "PUBLIC_KEY",
          label: "Public key",
          derive: { from: "PRIVATE_KEY", method: "vapid-public-key" },
          optional: false,
        },
      ],
      [
        { name: "SITE_NAME", label: "Site name", required: true, shownDefault: "" },
        {
          name: "THEME",
          label: "Theme",
          help: "light or dark",
          required: false,
          shownDefault: "dark",
        },
        { name: "NOTE", label: "Note", required: false, shownDefault: "" },
        {
          name: "HASH",
          label: "Hash",
          required: false,
          shownDefault: "",
          derivedFrom: "ADMIN_PASSWORD",
        },
      ],
    );
    const none = { description: null };
    expect(items).toEqual([
      {
        label: "Admin password",
        name: "ADMIN_PASSWORD",
        hint: "Required",
        description: "Signs you in to the app.",
      },
      { label: "Session key", name: "SESSION_KEY", hint: "Filled in for you", ...none },
      { label: "Mail token", name: "SMTP_TOKEN", hint: "Optional", ...none },
      { label: "Site name", name: "SITE_NAME", hint: "Required", ...none },
      {
        label: "Theme",
        name: "THEME",
        hint: "Suggested value filled in",
        description: "light or dark",
      },
      { label: "Note", name: "NOTE", hint: "Optional", ...none },
    ]);
  });
});

describe("links", () => {
  const catalog = {
    repo: "acme/cut",
    homepage: "https://cut.example.com",
    source: { sha: "abc123" },
  };

  it("lists the source code, the website and a page about the license", () => {
    expect(appLinks(catalog, { expression: "MIT", note: null })).toEqual([
      {
        kind: "repository",
        label: "Source code",
        href: "https://github.com/acme/cut",
        detail: "github.com/acme/cut",
      },
      {
        kind: "website",
        label: "Website",
        href: "https://cut.example.com",
        detail: "cut.example.com",
      },
      {
        kind: "license",
        label: "About MIT",
        href: "https://choosealicense.com/licenses/mit/",
        detail: "choosealicense.com",
      },
    ]);
  });

  it("leaves out a website that is the repository, and links a license file at the pinned commit", () => {
    const links = appLinks(
      { ...catalog, homepage: "https://github.com/acme/cut/" },
      { expression: "SEE LICENSE IN LICENSE.md", note: null },
    );
    expect(links.map((l) => l.kind)).toEqual(["repository", "license"]);
    expect(links[1]).toMatchObject({
      href: "https://github.com/acme/cut/blob/abc123/LICENSE.md",
      detail: "LICENSE.md",
    });
  });

  it("has no license link without a license, or for an expression of several", () => {
    expect(appLinks(catalog, null).map((l) => l.kind)).toEqual(["repository", "website"]);
    expect(appLinks(catalog, { expression: "NONE", note: null }).map((l) => l.kind)).toEqual([
      "repository",
      "website",
    ]);
    expect(
      appLinks(catalog, { expression: "MIT OR Apache-2.0", note: null }).map((l) => l.kind),
    ).toEqual(["repository", "website"]);
  });
});
