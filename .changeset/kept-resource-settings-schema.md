---
"@appflare/schema": patch
---

The lifecycle rules Appflare puts on an R2 bucket have ids that start with `appflare:` (`R2_MANAGED_LIFECYCLE_RULE_PREFIX`), and `mergeR2LifecycleRules` replaces only rules of those ids, where they stand, so a rule added to the bucket by hand is never replaced, even one named like a declared rule. `undeclaredR2LifecycleRuleIds` names the rules Appflare set that a declaration no longer has. A declared rule id is now at most 55 characters, so the id on the bucket stays within 64.
