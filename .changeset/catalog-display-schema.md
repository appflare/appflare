---
"@appflare/schema": minor
---

Adds `@appflare/schema/catalog-display`, the client-safe helpers the manager's catalog pages and the docs site share, so an app reads the same in both: `appPitch` (the tagline), the category list and its labels (`CATALOG_CATEGORIES`, `CATALOG_CATEGORY_IDS`, `isCatalogCategory`, and `categoryLabel`, which also spells out an id the list does not know), the license badge (`licenseBadgeCopy`, `licenseKind`), popularity (`freshStats`, `appPopularity`, `comparePopularity`, `formatCount`), the plan wording (`PLAN_WORDS`, `PLAN_STATS`), service names with "This app needs it" and "This app uses it" (`SERVICE_NAMES`, `serviceName`, `serviceNeedWords`, `declaredServices`) and `dateBuildDay`. It has no Zod in it: the category list and the license rules, SPDX list checks included, move to their own modules, still exported from the package root. Also exports `CATALOG_SLUG_PATTERN`, the strict slug form the sandbox request already used.
