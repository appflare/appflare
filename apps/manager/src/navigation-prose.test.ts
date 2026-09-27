import { describe, expect, it } from "vitest";

/**
 * Wording that tells people where to click instead of linking there. A place
 * in the manager is a link, built with `settingsLink`/`appLink` (or
 * `settingsPlace`/`appPlace` inside a message string), so it never goes stale
 * when a section moves. Every source file of the manager except tests, read
 * at build time; comments are left out, since they are not shown to anyone.
 */
const SOURCES = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The installer, the shared schema and the sandbox Worker, which print or
 * return text the manager did not write, so they cannot use its links.
 * Their few place names are listed in {@link KEPT}; anything new is caught.
 */
const OTHER_SOURCES = import.meta.glob<string>(
  [
    "../../../packages/cli/src/**/*.ts",
    "../../../packages/schema/src/**/*.ts",
    "../../sandbox/src/**/*.ts",
    "!../../../packages/*/src/**/*.test.ts",
    "!../../sandbox/src/**/*.test.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** Place names outside the manager that stay plain text on purpose, with why. */
const KEPT: ReadonlyArray<{ file: string; text: string; why: string }> = [
  {
    file: "packages/cli/src/manager-pages.ts",
    text: '"Settings > ',
    why: "the installer prints each page's name next to its full address",
  },
  {
    file: "packages/schema/src/artifact.ts",
    text: 'UPDATE_APPFLARE_PLACE = "Settings > Updates"',
    why: "shared with the installer and the packer; the manager swaps it for a link",
  },
  {
    file: "sandbox/src/repository.ts",
    text: "delete it in Settings > Building apps > GitHub access",
    why: "the sandbox Worker is a separate Worker whose errors are plain text",
  },
];

function isKept(finding: string): boolean {
  return KEPT.some((k) => finding.includes(`${k.file}:`) && finding.includes(k.text));
}

const PAGES =
  "Your account|Building apps|Updates|Users and sign-in|Users|Domains|Notifications|Catalogs|Removed apps|Usage data|General|Account and capabilities|Appflare updates";

const PATTERNS: ReadonlyArray<[name: string, pattern: RegExp]> = [
  ["a settings breadcrumb", new RegExp(`Settings\\s*[›>]\\s*(?:${PAGES})\\b`)],
  ["a settings page after a comma", new RegExp(`Settings, (?:${PAGES})\\b`)],
  ["in, under or from Settings", /\b(?:in|under|from) Settings\b/],
  ["the Settings page", /\bthe Settings page\b/],
  [
    "a tab of the app page by name",
    /\b(?:Settings|Overview|Jobs|Resources|Domains and email) tabs?\b/,
  ],
  ["a section of the app page by name", /\bthe Settings section\b/],
  ["the install page", /\bthe install page\b/],
  ["an old page or section name", /\b(?:Account and capabilities|Onboarding checklist)\b/],
  ["an old button name", /\b(?:Re-check|Enable now)\b/],
  ["the old updates page", /\bAppflare updates\b(?! it)/],
];

/** The source without its comments: block comments (JSX ones included) and whole-line `//` comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every match of `pattern` in the files, as `file:line: text`. */
function findings(pattern: RegExp, sources: Record<string, string> = SOURCES): string[] {
  const found: string[] = [];
  for (const [file, raw] of Object.entries(sources)) {
    withoutComments(raw)
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

describe("wording that names a place in the manager", () => {
  it("reads the manager's source", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(300);
    expect(Object.keys(SOURCES).some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  it.each(PATTERNS)("has no %s", (_name, pattern) => {
    expect(findings(pattern)).toEqual([]);
  });

  it("reads the installer, the schema and the sandbox Worker too", () => {
    const files = Object.keys(OTHER_SOURCES);
    for (const dir of ["packages/cli/src/", "packages/schema/src/", "sandbox/src/"]) {
      expect(
        files.some((f) => f.includes(dir)),
        dir,
      ).toBe(true);
    }
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  it.each(PATTERNS)("has no %s outside the manager, but the kept ones", (_name, pattern) => {
    expect(findings(pattern, OTHER_SOURCES).filter((f) => !isKept(f))).toEqual([]);
  });

  it("keeps no entry that no longer matches anything", () => {
    const all = PATTERNS.flatMap(([, pattern]) => findings(pattern, OTHER_SOURCES));
    for (const k of KEPT) {
      expect(
        all.some((f) => f.includes(`${k.file}:`) && f.includes(k.text)),
        `${k.file}: ${k.why}`,
      ).toBe(true);
    }
  });

  it("would catch each pattern", () => {
    const samples = [
      "Open Settings > Building apps > GitHub access.",
      "turn it off under Settings, Usage data",
      "Save the Cloudflare token under Settings first.",
      "Reload the Settings page.",
      "use the Settings tab",
      "from the Settings section of the install page",
      "Roll back from the install page.",
      "Settings › Account and capabilities",
      "Select Re-check.",
      "open Appflare updates",
    ];
    for (const [name, pattern] of PATTERNS) {
      expect(
        samples.some((s) => pattern.test(s)),
        name,
      ).toBe(true);
    }
    // Other sites' own menus and plain wording stay allowed.
    const allowed = [
      "Settings › Builds › Disconnect",
      "Appflare updates itself when nothing else runs",
      "Only admins can change settings.",
    ];
    for (const text of allowed) {
      for (const [name, pattern] of PATTERNS)
        expect(pattern.test(text), `${name}: ${text}`).toBe(false);
    }
  });
});
