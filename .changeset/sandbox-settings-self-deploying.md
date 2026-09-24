---
"@appflare/schema": minor
---

`install.sandbox` is now allowed on `self-deploying` tier entries as well as `sandbox` ones, since both run in the account's sandbox Worker: a self-deploying entry's installer occupies the same container, so its `expectedMinutes` and `instanceType` size that run and feed the cost the manager shows before each install and update. It is still refused on `artifact` entries, and the JSON Schema states the same rule (`tier` must be `sandbox` or `self-deploying` when `sandbox` is present). New exports: `SANDBOX_RUN_TIERS` and `runsInSandbox(tier)`.
