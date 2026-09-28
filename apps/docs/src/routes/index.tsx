import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "../components/landing/landing-page.tsx";
import { landingData } from "../lib/landing.ts";
import { pageHead } from "../lib/meta.ts";
import { ogImagePath, SITE_URL, siteDescription, siteName } from "../lib/shared.ts";

/**
 * `/`, the front page: what Appflare is, the Deploy button and the catalog
 * at a glance. The documentation starts at `/start/overview/`.
 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const { siteCatalog } = await import("../catalog/data.ts");
    return landingData(siteCatalog);
  },
  head: () =>
    pageHead({
      title: `${siteName}: the app manager for your own Cloudflare account`,
      description: siteDescription,
      url: `${SITE_URL}/`,
      image: `${SITE_URL}${ogImagePath([])}`,
    }),
  component: Landing,
});

function Landing() {
  return <LandingPage data={Route.useLoaderData()} />;
}
