import { describe, expect, it } from "vitest";
import {
  buildCommandChoiceSchema,
  githubRepositorySchema,
  gitRefSchema,
  INSPECT_OUTPUT_PREFIX,
  parseInspectOutput,
  parseJsonc,
  parseRepositoryInput,
  repositoryBuildRequestSchema,
  SANDBOX_PROTOCOL_VERSION,
} from "./index";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("parseRepositoryInput", () => {
  it("reads owner/repo and GitHub URLs, with the branch, tag or commit they point at", () => {
    expect(parseRepositoryInput("MendyLanda/cut")).toEqual({
      ok: true,
      repo: "MendyLanda/cut",
      ref: null,
    });
    expect(parseRepositoryInput(" https://github.com/MendyLanda/cut.git/ ")).toMatchObject({
      ok: true,
      repo: "MendyLanda/cut",
    });
    expect(parseRepositoryInput("github.com/MendyLanda/cut")).toMatchObject({ ok: true });
    expect(parseRepositoryInput("https://github.com/o/r/tree/feat/home")).toEqual({
      ok: true,
      repo: "o/r",
      ref: "feat/home",
    });
    expect(parseRepositoryInput(`https://github.com/o/r/commit/${SHA}`)).toMatchObject({
      ref: SHA,
    });
  });

  it("refuses other hosts, other pages and things that are not repositories", () => {
    expect(parseRepositoryInput("https://gitlab.com/o/r")).toEqual({
      ok: false,
      error: "Only repositories on github.com can be installed.",
    });
    for (const text of [
      "",
      "cut",
      "https://github.com/o/r/issues/1",
      "https://github.com/o/r/commit/main",
      "https://github.com/o/r?tab=readme",
      "ssh://git@github.com/o/r",
      "o/..",
      "-o/r",
    ]) {
      expect(parseRepositoryInput(text).ok, text).toBe(false);
    }
  });
});

describe("refs and repositories", () => {
  it("accepts what git accepts on a command line, nothing that could be an option", () => {
    for (const ok of ["main", "feat/home", "v1.2.3", "release-2026.09", SHA]) {
      expect(gitRefSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["-x", "a..b", "a b", "a;b", "a/", "/a", "x.lock", "$(id)"]) {
      expect(gitRefSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(githubRepositorySchema.safeParse("o/r.git").success).toBe(false);
  });

  it("takes a build command only when it runs without a shell", () => {
    expect(
      buildCommandChoiceSchema.safeParse({ mode: "command", command: "pnpm run build" }).success,
    ).toBe(true);
    expect(
      buildCommandChoiceSchema.safeParse({ mode: "command", command: "npm i && curl x" }).success,
    ).toBe(false);
  });
});

describe("repositoryBuildRequestSchema", () => {
  const request = {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: "01J8REPO",
    runId: "src-01J8JOB",
    repo: "MendyLanda/cut",
  };

  it("needs only the repository; the default branch and detection are the defaults", () => {
    expect(repositoryBuildRequestSchema.parse(request)).toEqual(request);
  });

  it("refuses a catalog manifest of another repository, and a commit that contradicts the ref", () => {
    const issues = (r: Record<string, unknown>) =>
      repositoryBuildRequestSchema.safeParse(r).error?.issues.map((i) => i.path.join("."));
    expect(issues({ ...request, ref: SHA, commit: "f".repeat(40) })).toEqual(["commit"]);
    expect(
      issues({
        ...request,
        baseline: {
          slug: "cut",
          name: "Cut",
          summary: "s",
          homepage: "https://example.com",
          repo: "someone/else",
          license: "MIT",
          categories: [],
          maintainers: [],
          source: { ref: "main", sha: SHA },
          install: {
            tier: "artifact",
            packageManager: "pnpm",
            wranglerConfig: "wrangler.jsonc",
            workerName: "cut",
          },
          plan: "free",
          requires: [],
          secrets: [],
          vars: [],
          postInstall: [],
          tokenPermissions: [],
        },
      }),
    ).toEqual(["baseline.repo"]);
  });
});

describe("parseJsonc", () => {
  it("reads a wrangler.jsonc with comments and trailing commas", () => {
    expect(
      parseJsonc('{ // x\n "name": "cut", /* y */ "vars": { "A": "//not a comment", }, }'),
    ).toEqual({
      name: "cut",
      vars: { A: "//not a comment" },
    });
  });
});

describe("parseInspectOutput", () => {
  it("reads the required secrets, and none from a packer that did not print them", () => {
    expect(
      parseInspectOutput(
        `${INSPECT_OUTPUT_PREFIX}{"name":"mail","vars":[],"unsupported":[],"secrets":["API_KEY"]}`,
      ),
    ).toEqual({ name: "mail", vars: [], unsupported: [], secrets: ["API_KEY"] });
    expect(
      parseInspectOutput(`${INSPECT_OUTPUT_PREFIX}{"name":"cut","vars":["A"],"unsupported":[]}`),
    ).toEqual({ name: "cut", vars: ["A"], unsupported: [], secrets: [] });
  });
});
