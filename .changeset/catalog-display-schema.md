---
"@appflare/schema": minor
---

Adds `@appflare/schema/catalog-display`, the client-safe helpers the manager's catalog pages and the docs site share, so an app reads the same in both: `appPitch`, the category ids and labels (`CATEGORY_IDS`, `categoryLabel`, `canonicalCategory`), the license badge (`licenseBadgeCopy`, `licenseKind`), popularity (`freshStats`, `appPopularity`, `comparePopularity`, `formatCount`), the plan wording (`PLAN_WORDS`, `PLAN_STATS`), service names with "This app needs it" and "This app uses it" (`SERVICE_NAMES`, `serviceName`, `serviceNeedWords`, `declaredServices`) and `dateBuildDay`. It has no Zod in it: the license expression rules move to their own module, still exported from the package root. Also exports `CATALOG_SLUG_PATTERN`, the strict slug form the sandbox request already used.
