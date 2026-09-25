---
"@appflare/schema": patch
---

Add the build-from-a-repository contract of the sandbox Worker: `SANDBOX_FEATURE_REPOSITORY`, the request (`repositoryBuildRequestSchema`: repository, optional branch, tag or commit, the commit it must end at, the build command choice, an optional catalog manifest as baseline, and versions the build must not reuse), the result with what was detected (`repositoryBuildOutcomeSchema`), and the helpers `parseRepositoryInput`, `githubRepositorySchema`, `gitRefSchema`, `isCommitSha`, `repositoryUrl` and `buildCommandChoiceSchema`. Build failures may name the new `detect` step. `UNSUPPORTED_WRANGLER_SECTIONS`, `wranglerFactsSchema` and `parseInspectOutput` describe what `appflare-pack inspect` reports. The JSONC parser the packer uses moves here as `parseJsonc`, so the sandbox Worker can read a wrangler config.
