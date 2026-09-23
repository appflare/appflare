// Conventional Commits: `type(scope): subject` with a lower-case subject, a
// header of at most 72 characters, and body lines of at most 100. CI lints every
// commit of a push or pull request with this config.

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 72],
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "build", "chore", "ci", "docs", "refactor", "test", "perf"],
    ],
    "subject-case": [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]],
    "body-max-line-length": [2, "always", 100],
  },
};
