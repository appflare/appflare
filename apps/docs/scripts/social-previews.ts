// Writes the social preview images of the three GitHub repositories into
// docs/assets/, drawn with the same pieces as the site's OpenGraph cards:
//
//   social-preview.png          appflare/appflare
//   social-preview-catalog.png  appflare/catalog
//   social-preview-deploy.png   appflare/deploy
//
//   CATALOG_SNAPSHOT=live pnpm --filter @appflare/docs social-previews
//
// With CATALOG_SNAPSHOT=live the catalog image shows the published apps'
// icons; from the checked-in snapshot it shows their first letters. GitHub
// has no API for a repository's social preview, so each image is uploaded by
// hand (see docs/RELEASING.md). Needs @appflare/schema built
// (`pnpm --filter @appflare/schema build`).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { comparePopularity } from "@appflare/schema/catalog-display";
import { render } from "takumi-js";
import { createServer } from "vite";
import { loadCatalog, snapshotMode } from "../src/catalog/plugin.ts";
import { readDocsScreenshots } from "../src/og/plugin.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const assets = new URL("../../../docs/assets/", import.meta.url);

const catalog = await loadCatalog(snapshotMode(process.env.CATALOG_SNAPSHOT));
const apps = [...catalog.site.apps]
  .sort((a, b) => comparePopularity(a.popularity, b.popularity))
  .map((app) => ({ name: app.name, pitch: app.pitch, icon: catalog.ogIcons[app.slug] ?? null }))
  .sort((a, b) => Number(b.icon !== null) - Number(a.icon !== null));

const screenshot = readDocsScreenshots()["/screenshots/home-dashboard.png"];
if (screenshot === undefined) throw new Error("public/screenshots/home-dashboard.png is missing");

// Vite compiles the card components (TSX, and the logos they import as text).
const server = await createServer({
  root,
  configFile: false,
  logLevel: "warn",
  appType: "custom",
  server: { middlewareMode: true, hmr: false },
});
try {
  const social = (await server.ssrLoadModule(
    "/src/og/social.tsx",
  )) as typeof import("../src/og/social.tsx");
  const previews = {
    "social-preview.png": { repo: "appflare", screenshot },
    "social-preview-catalog.png": { repo: "catalog", apps, count: apps.length },
    "social-preview-deploy.png": { repo: "deploy" },
  } as const satisfies Record<string, import("../src/og/social.tsx").SocialPreview>;
  for (const [file, preview] of Object.entries(previews)) {
    const png = await render(social.socialPreviewElement(preview), {
      width: social.SOCIAL_WIDTH,
      height: social.SOCIAL_HEIGHT,
      format: "png",
    });
    writeFileSync(new URL(file, assets), png);
    console.log(`Wrote docs/assets/${file}`);
  }
} finally {
  await server.close();
}
