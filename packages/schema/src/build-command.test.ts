import { describe, expect, it } from "vitest";
import { buildCommandArgv, buildCommandProblem, MAX_BUILD_COMMAND_LENGTH } from "./catalog";

describe("buildCommandArgv", () => {
  it("splits on spaces and drops empty words", () => {
    expect(buildCommandArgv("pnpm  --filter @x/web   build")).toEqual([
      "pnpm",
      "--filter",
      "@x/web",
      "build",
    ]);
  });
});

describe("buildCommandProblem", () => {
  it("accepts a plain command", () => {
    expect(buildCommandProblem("pnpm --filter @flaremo/web build")).toBeNull();
    expect(buildCommandProblem("node scripts/build.mjs --out=dist")).toBeNull();
    expect(buildCommandProblem("x".repeat(MAX_BUILD_COMMAND_LENGTH))).toBeNull();
  });

  it("names the first character a shell would interpret", () => {
    for (const char of [
      "|",
      "&",
      ";",
      "<",
      ">",
      "(",
      ")",
      "$",
      "`",
      "\\",
      '"',
      "'",
      "*",
      "?",
      "~",
      "#",
      "!",
      "{",
      "[",
      "^",
    ]) {
      expect(buildCommandProblem(`pnpm build ${char}`)).toContain(`"${char}"`);
    }
    expect(buildCommandProblem("pnpm build\nrm x")).toContain("U+000A");
  });

  it("refuses environment assignments anywhere in the command", () => {
    expect(buildCommandProblem("CI=1 pnpm build")).toContain('"CI=1"');
    expect(buildCommandProblem("pnpm exec cross-env NODE_ENV=production vite build")).toContain(
      "NODE_ENV=production",
    );
    // An option with a value is not an assignment.
    expect(buildCommandProblem("vite build --mode=selfhost")).toBeNull();
  });

  it("refuses an empty, over-long, or option-first command", () => {
    expect(buildCommandProblem("  ")).toBe("is empty");
    expect(buildCommandProblem("x".repeat(MAX_BUILD_COMMAND_LENGTH + 1))).toContain("longer");
    expect(buildCommandProblem("--help")).toContain("option");
  });
});
