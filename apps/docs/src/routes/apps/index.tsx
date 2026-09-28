import { createFileRoute } from "@tanstack/react-router";
import Link from "fumadocs-core/link";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { longDate } from "../../catalog/app-page.ts";
import { appsPageDescription, appsPageTitle } from "../../catalog/pages.ts";
import { appsByName, searchApps, storefrontRows } from "../../catalog/storefront.ts";
import { appsPath } from "../../catalog/urls.ts";
import { CatalogHeader, CatalogLayout } from "../../components/catalog/catalog-layout.tsx";
import {
  AppGrid,
  AppRow,
  CatalogSection,
  CategoryCards,
  FeaturedCard,
} from "../../components/catalog/tiles.tsx";
import { pageHead } from "../../lib/meta.ts";
import { ogImagePath, siteName, siteUrl } from "../../lib/shared.ts";

/** The longest search kept in the address. */
const MAX_QUERY_LENGTH = 200;

/**
 * Whether this site shows the catalog's sponsored item, as the manager's
 * catalog page does. Off until it is decided that the public site carries it;
 * the card and its data stay ready.
 */
const SHOW_SPONSORED = false;

/** Apps of the full list a phone shows before "Show all". */
const PHONE_LIST_LENGTH = 24;

/**
 * `/apps/`: every app in the catalog, laid out as Appflare's own catalog
 * page. A search field first, then the categories, then rows picked for a
 * first look (new, most popular, the biggest categories) with the sponsored
 * item among them, then every app by name. Typing in the search field lists
 * the matching apps instead; the words stay in the address (`?q=`) so a
 * search can be shared.
 */
export const Route = createFileRoute("/apps/")({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q !== ""
      ? { q: search.q.slice(0, MAX_QUERY_LENGTH) }
      : {},
  loader: async () => {
    const { siteCatalog } = await import("../../catalog/data.ts");
    return { catalog: siteCatalog };
  },
  head: () =>
    pageHead({
      title: `${appsPageTitle} | ${siteName}`,
      description: appsPageDescription,
      url: `${siteUrl}${appsPath}`,
      image: `${siteUrl}${ogImagePath(["apps"])}`,
    }),
  component: AppsPage,
});

function AppsPage() {
  const { catalog } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const inputId = useId();
  // The page is prerendered without a search, so the address's search is
  // applied once the page is running in the browser.
  const [text, setText] = useState("");
  // Only on arrival: after that the field leads and the address follows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (search.q !== undefined) setText(search.q);
  }, []);

  const now = useMemo(() => new Date(catalog.takenAt), [catalog.takenAt]);
  const rows = useMemo(
    () => storefrontRows(catalog.apps, catalog.categories, now),
    [catalog.apps, catalog.categories, now],
  );
  const byName = useMemo(() => appsByName(catalog.apps), [catalog.apps]);
  const results = text.trim() === "" ? null : searchApps(catalog.apps, text);
  const featuredApp =
    catalog.featured?.slug === undefined
      ? null
      : (catalog.apps.find((app) => app.slug === catalog.featured?.slug)?.name ?? null);
  const featured =
    !SHOW_SPONSORED || catalog.featured === null ? null : (
      <FeaturedCard item={catalog.featured} appName={featuredApp} />
    );
  // Every app stays in the page (and in its links); a phone hides the rest until asked.
  const [allShown, setAllShown] = useState(false);

  function onText(value: string) {
    setText(value);
    const q = value.trim() === "" ? undefined : value.slice(0, MAX_QUERY_LENGTH);
    void navigate({ search: q === undefined ? {} : { q }, replace: true, resetScroll: false });
  }

  return (
    <CatalogLayout>
      <CatalogHeader title={appsPageTitle} description={appsPageDescription}>
        <p className="text-fd-muted-foreground text-sm">
          New to Appflare? Read{" "}
          <Link href="/guides/install-apps/" className="text-fd-primary underline">
            how installing an app works
          </Link>
          .
        </p>
      </CatalogHeader>

      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor={inputId} className="sr-only">
            Search apps
          </label>
          <input
            id={inputId}
            type="search"
            value={text}
            onChange={(event) => onText(event.target.value)}
            placeholder="Search apps"
            autoComplete="off"
            className="h-11 w-full rounded-xl border border-fd-border bg-fd-card px-4 text-base outline-none placeholder:text-fd-muted-foreground focus-visible:ring-2 focus-visible:ring-fd-ring"
          />
          <p className="px-1 text-fd-muted-foreground text-sm">
            <span role="status">
              {results === null
                ? `${catalog.apps.length} apps`
                : `${results.length} of ${catalog.apps.length} apps`}
            </span>
            {" · "}
            <time dateTime={catalog.generatedAt}>Updated {longDate(catalog.generatedAt)}</time>
          </p>
        </div>
        <CategoryCards categories={catalog.categories} />
      </div>

      {results !== null ? (
        results.length === 0 ? (
          <div className="grid justify-items-center gap-3 rounded-xl border border-fd-border border-dashed px-6 py-12 text-center">
            <p className="font-semibold text-lg">No apps match</p>
            <p className="text-fd-muted-foreground">Try other words.</p>
            <button
              type="button"
              onClick={() => onText("")}
              className="rounded-md border border-fd-border px-3 py-1.5 font-medium text-sm hover:bg-fd-accent"
            >
              Show all apps
            </button>
          </div>
        ) : (
          <CatalogSection title="Results">
            <AppGrid apps={results} />
          </CatalogSection>
        )
      ) : (
        <>
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              <AppRow row={row} />
              {index === 0 && featured}
            </Fragment>
          ))}
          {rows.length === 0 && featured}
          <CatalogSection title="All apps">
            <AppGrid apps={byName} phoneLimit={allShown ? undefined : PHONE_LIST_LENGTH} />
            {!allShown && byName.length > PHONE_LIST_LENGTH && (
              <button
                type="button"
                onClick={() => setAllShown(true)}
                className="justify-self-center rounded-md border border-fd-border px-4 py-2 font-medium text-sm hover:bg-fd-accent sm:hidden"
              >
                Show all {byName.length} apps
              </button>
            )}
          </CatalogSection>
        </>
      )}
    </CatalogLayout>
  );
}
