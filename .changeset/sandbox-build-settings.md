---
"@appflare/schema": minor
---

The catalog manifest takes an optional `install.sandbox: { expectedMinutes?, instanceType? }` for `sandbox` tier entries, which are built in the user's account. `expectedMinutes` (a whole number from 1 to 120, default 10) is about how long one build takes, and `instanceType` (`"standard-1"` by default, or `"standard-2"` for builds that need more memory or disk) is the container it runs on; together they give the build cost the manager shows before an install or update. Setting `install.sandbox` on any other tier is refused, and the JSON Schema states the same rule. `sandboxBuildSettings()` returns both values with the defaults filled in. `sandboxInstanceTypeSchema`, `DEFAULT_SANDBOX_INSTANCE_TYPE` and `DEFAULT_EXPECTED_BUILD_MINUTES` keep their names and are still exported from the package root.
