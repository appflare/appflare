// Rewrites src/catalog/fixture.json, the snapshot the site is built from
// without `CATALOG_SNAPSHOT=live`, from the published catalog. The apps are
// chosen to cover every part of the catalog pages: icons, a cover and
// screenshots, an app with its own installer, a paid app, Email Routing,
// a revised entry, and licenses of each kind.
//
//   pnpm --filter @appflare/docs catalog:fixture
//
// Needs @appflare/schema built (`pnpm --filter @appflare/schema build`).
import { writeFileSync } from "node:fs";
import { fetchCatalogSnapshot } from "../src/catalog/fetch-snapshot.ts";
import { fixtureUrl } from "../src/catalog/plugin.ts";

const FIXTURE_APPS = [
  "2fa",
  "agentic-inbox",
  "cattopic",
  "flaremo",
  "mailflare",
  "open-seo",
  "resolvehq",
  "veet",
];

const { snapshot } = await fetchCatalogSnapshot({ only: FIXTURE_APPS, ogIcons: false });
const found = new Set(snapshot.index.apps.map((app) => app.slug));
const missing = FIXTURE_APPS.filter((slug) => !found.has(slug));
if (missing.length > 0) throw new Error(`Not in the catalog any more: ${missing.join(", ")}`);
writeFileSync(fixtureUrl, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${found.size} apps to ${fixtureUrl.pathname}`);
