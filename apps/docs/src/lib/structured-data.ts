import type { SiteApp } from "../catalog/site-catalog.ts";
import { appPath, appsPath } from "../catalog/urls.ts";
import { repositoryUrl, SITE_URL, siteDescription, siteName } from "./shared.ts";

/**
 * The schema.org data (https://schema.org) a page states about itself, written
 * into its `<head>` as JSON-LD, so search engines read an app page as an app
 * and the front page as Appflare's own site.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One JSON-LD document: `@context` and a `@graph` of the page's things. */
export type StructuredData = { [key: string]: JsonValue };

function graph(...nodes: Array<{ [key: string]: JsonValue }>): StructuredData {
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** The organization that makes Appflare; the front page and app pages name it. */
const organization = {
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: siteName,
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/web-app-manifest-512x512.png`,
  sameAs: [repositoryUrl],
};

/** The front page: the site, the organization, and Appflare itself as an app. */
export function siteStructuredData(): StructuredData {
  return graph(
    organization,
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: siteName,
      url: `${SITE_URL}/`,
      description: siteDescription,
      publisher: { "@id": organization["@id"] },
    },
    {
      "@type": "WebApplication",
      name: siteName,
      url: `${SITE_URL}/`,
      description: siteDescription,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Cloudflare Workers",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      sameAs: [repositoryUrl],
      publisher: { "@id": organization["@id"] },
    },
  );
}

/**
 * An app's page: the app, as a web application that runs on Cloudflare
 * Workers and costs nothing to install, and the breadcrumb above its name.
 */
export function appStructuredData(app: SiteApp): StructuredData {
  const url = `${SITE_URL}${appPath(app.slug)}`;
  const images = app.screenshots.map((shot) => shot.url);
  const sameAs = [...new Set([`https://github.com/${app.repo}`, app.homepage])].filter(
    (link) => link !== "" && link !== url,
  );
  return graph(
    {
      "@type": "WebApplication",
      "@id": `${url}#app`,
      name: app.name,
      url,
      description: app.summary,
      headline: app.pitch,
      softwareVersion: app.version,
      applicationCategory: "WebApplication",
      operatingSystem: "Cloudflare Workers",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      ...(app.icon === null ? {} : { image: app.icon }),
      ...(images.length === 0 ? {} : { screenshot: images }),
      sameAs,
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Apps", item: `${SITE_URL}${appsPath}` },
        { "@type": "ListItem", position: 2, name: app.name, item: url },
      ],
    },
  );
}
