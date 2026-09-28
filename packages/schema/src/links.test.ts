import { describe, expect, it } from "vitest";
import { githubRepositorySchema, gitRefSchema } from "./index";
import { CATALOG_SLUG_PATTERN, isGithubRepository, isGitRef, parseRepositoryInput } from "./links";

describe("links", () => {
  it("refuses a repository address with a malformed escape instead of throwing", () => {
    for (const text of [
      "https://github.com/a/%E0",
      "https://github.com/a/%25E0%",
      "https://github.com/%/r",
    ]) {
      expect(() => parseRepositoryInput(text), text).not.toThrow();
      expect(parseRepositoryInput(text).ok, text).toBe(false);
    }
    // The double-encoded form decodes once, to a name GitHub does not allow.
    expect(parseRepositoryInput("https://github.com/a/%25E0").ok).toBe(false);
  });

  it("checks the same way as the schemas built on it", () => {
    for (const repo of ["o/r", "Owner-1/r.js_x", "o/..", "-o/r", "o/r.git", "o/r/x", "o"]) {
      expect(isGithubRepository(repo), repo).toBe(githubRepositorySchema.safeParse(repo).success);
    }
    for (const ref of [
      "main",
      "feat/home",
      "v1.2.3",
      "",
      "-x",
      "a..b",
      "a//b",
      "x.lock",
      "a b",
      "x".repeat(201),
    ]) {
      expect(isGitRef(ref), ref).toBe(gitRefSchema.safeParse(ref).success);
    }
    expect(CATALOG_SLUG_PATTERN.test("2fa")).toBe(true);
    expect(CATALOG_SLUG_PATTERN.test("-x")).toBe(false);
  });
});
