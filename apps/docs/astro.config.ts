import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { canIndexSearch } from "./src/build/search.ts";
import { manifestReference } from "./src/reference/integration.ts";

const search = canIndexSearch();
if (!search) {
  console.warn(
    "Pagefind cannot run on this host (Linux arm64 with memory pages over 4 KiB); " +
      "building the docs without search. Build on another host to include it.",
  );
}

export default defineConfig({
  site: "https://appflare-docs.appflare-dev.workers.dev",
  integrations: [
    // Generates the manifest reference page before Starlight loads the content.
    manifestReference(),
    starlight({
      title: "Appflare",
      description:
        "A self-hosted app manager for Cloudflare. Install, update, and remove Cloudflare-native apps in your own account.",
      logo: {
        light: "../../docs/assets/logo_full.svg",
        dark: "../../docs/assets/logo_full_white.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/appflare/appflare" }],
      editLink: {
        baseUrl: "https://github.com/appflare/appflare/edit/main/apps/docs/",
      },
      lastUpdated: false,
      pagefind: search,
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "What Appflare is", slug: "start/overview" },
            { label: "Install Appflare", slug: "start/install" },
          ],
        },
        {
          label: "Using Appflare",
          items: [
            { label: "Browse the catalog", slug: "guides/catalog" },
            { label: "Install an app", slug: "guides/install-apps" },
            { label: "Health checks", slug: "guides/health" },
            { label: "Update and roll back", slug: "guides/updates" },
            { label: "Uninstall an app", slug: "guides/uninstall" },
            { label: "Update Appflare", slug: "guides/update-appflare" },
            { label: "Users and roles", slug: "guides/users" },
            { label: "Command line", slug: "guides/cli" },
          ],
        },
        {
          label: "Catalog",
          items: [
            { label: "How the catalog works", slug: "catalog/how-it-works" },
            { label: "Submit an app", slug: "catalog/submit" },
            { label: "Version bumps", slug: "catalog/bumps" },
            { label: "Manifest reference", slug: "catalog/manifest-reference" },
          ],
        },
        { label: "Security model", slug: "security" },
        { label: "FAQ", slug: "faq" },
      ],
    }),
  ],
});
