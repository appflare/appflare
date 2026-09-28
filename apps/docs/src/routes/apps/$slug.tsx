import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import { createFileRoute, notFound } from "@tanstack/react-router";
import Link from "fumadocs-core/link";
import { useEffect } from "react";
import { track } from "../../analytics/analytics.ts";
import {
  accountNeeds,
  appCategories,
  appLinks,
  appPageTitle,
  appStats,
} from "../../catalog/app-page.ts";
import { appPath, appsPath, categoryPath, installPath } from "../../catalog/urls.ts";
import {
  AppSection,
  AuthorsList,
  LinksList,
  NeedsList,
  ScreenshotGallery,
  StatStrip,
} from "../../components/catalog/app-sections.tsx";
import { CatalogLayout } from "../../components/catalog/catalog-layout.tsx";
import { AppIcon } from "../../components/catalog/tiles.tsx";
import { pageHead } from "../../lib/meta.ts";
import { ogImagePath, SITE_URL, siteName } from "../../lib/shared.ts";

/**
 * `/apps/<slug>/`: one app, laid out as its page in Appflare: the header with
 * Install, the stat strip, the screenshots, what it does, what it needs on a
 * Cloudflare account, its links and who made it. "Install" leads to the
 * install page, which opens the app in the visitor's own Appflare.
 */
export const Route = createFileRoute("/apps/$slug")({
  loader: async ({ params }) => {
    const { findApp, siteCatalog } = await import("../../catalog/data.ts");
    const app = findApp(params.slug);
    if (!app) throw notFound();
    return { app, takenAt: siteCatalog.takenAt };
  },
  head: ({ loaderData }) =>
    loaderData
      ? pageHead({
          title: appPageTitle(loaderData.app, siteName),
          description: loaderData.app.summary,
          url: `${SITE_URL}${appPath(loaderData.app.slug)}`,
          image: `${SITE_URL}${ogImagePath(["apps", loaderData.app.slug])}`,
        })
      : {},
  component: AppPage,
});

/** A description split into paragraphs at blank lines. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p !== "");
}

function AppPage() {
  const { app, takenAt } = Route.useLoaderData();
  const now = new Date(takenAt);
  const images =
    app.screenshots.length > 0
      ? app.screenshots
      : app.cover === null
        ? []
        : [{ url: app.cover, alt: `${app.name} cover image` }];
  const authors = app.authors.map((author) => author.name);
  useEffect(() => {
    track("app_page_viewed", {
      slug: app.slug,
      category: app.categories[0] ?? null,
      categories: app.categories,
    });
  }, [app.slug, app.categories]);

  return (
    <CatalogLayout>
      <nav aria-label="Breadcrumb" className="-mb-6 text-fd-muted-foreground text-sm">
        <Link href={appsPath} className="hover:text-fd-foreground">
          Apps
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{app.name}</span>
      </nav>

      <div className="grid gap-6">
        <header className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <AppIcon src={app.icon} name={app.name} size={88} lazy={false} />
          <div className="grid min-w-0 flex-1 basis-72 gap-1.5">
            <h1 className="font-bold text-3xl tracking-tight">{app.name}</h1>
            <p className="text-fd-muted-foreground text-lg">{app.pitch}</p>
            {authors.length > 0 && (
              <p className="text-fd-muted-foreground text-sm">
                By {new Intl.ListFormat("en", { type: "conjunction" }).format(authors)}
              </p>
            )}
          </div>
          <div className="grid justify-items-start gap-1.5 sm:justify-items-end">
            <a
              href={installPath(app.slug)}
              className={buttonVariants({ variant: "primary", className: "px-6 py-2.5 text-base" })}
            >
              Install
            </a>
            <span className="text-fd-muted-foreground text-xs">Opens in your own Appflare</span>
          </div>
        </header>
        <StatStrip stats={appStats(app, now)} />
      </div>

      <ScreenshotGallery images={images} appName={app.name} />

      <AppSection title="About">
        <div className="grid max-w-3xl gap-3 text-base leading-relaxed">
          {paragraphs(app.summary).map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </AppSection>

      <AppSection title="What it needs on your account">
        <NeedsList needs={accountNeeds(app)} />
      </AppSection>

      <AppSection title="Links">
        <LinksList links={appLinks(app)} maintainers={app.maintainers} />
      </AppSection>

      {app.authors.length > 0 && (
        <AppSection title={app.authors.length === 1 ? "Author" : "Authors"}>
          <AuthorsList authors={app.authors} />
        </AppSection>
      )}

      {app.categories.length > 0 && (
        <AppSection title="Categories">
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {appCategories(app).map((category) => (
              <li key={category.id}>
                <Link
                  href={categoryPath(category.id)}
                  className="inline-flex rounded-full border border-fd-border bg-fd-card px-3 py-1 text-sm hover:bg-fd-accent"
                >
                  {category.label}
                </Link>
              </li>
            ))}
          </ul>
        </AppSection>
      )}
    </CatalogLayout>
  );
}
