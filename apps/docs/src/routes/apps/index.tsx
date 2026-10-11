import { createFileRoute } from "@tanstack/react-router";
import Link from "fumadocs-core/link";
import { Fragment, memo, type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { longDate } from "../../catalog/app-page.ts";
import { appsPageDescription, appsPageTitle } from "../../catalog/pages.ts";
import type { SiteApp } from "../../catalog/site-catalog.ts";
import { appsByName, type StorefrontRow, storefrontRows } from "../../catalog/storefront.ts";
import { appsPath, suggestAppUrl } from "../../catalog/urls.ts";
import { CatalogHeader, CatalogLayout } from "../../components/catalog/catalog-layout.tsx";
import {
  AppGrid,
  AppRow,
  CatalogSection,
  CategoryCards,
  FeaturedCard,
} from "../../components/catalog/tiles.tsx";
import { useCatalogSearch } from "../../components/catalog/use-catalog-search.ts";
import { pageHead } from "../../lib/meta.ts";
import { ogImagePath, SITE_URL, siteName } from "../../lib/shared.ts";

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
      url: `${SITE_URL}${appsPath}`,
      image: `${SITE_URL}${ogImagePath(["apps"])}`,
    }),
  component: AppsPage,
});

function AppsPage() {
  const { catalog } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const inputId = useId();
  const { text, query, results, change } = useCatalogSearch(catalog.apps, search.q, (value) => {
    const q = value.trim() === "" ? undefined : value.slice(0, MAX_QUERY_LENGTH);
    void navigate({ search: q === undefined ? {} : { q }, replace: true, resetScroll: false });
  });

  const now = useMemo(() => new Date(catalog.takenAt), [catalog.takenAt]);
  const rows = useMemo(
    () => storefrontRows(catalog.apps, catalog.categories, now),
    [catalog.apps, catalog.categories, now],
  );
  const byName = useMemo(() => appsByName(catalog.apps), [catalog.apps]);
  const featured = useMemo(() => {
    if (!SHOW_SPONSORED || catalog.featured === null) return null;
    const slug = catalog.featured.slug;
    const appName =
      slug === undefined ? null : (catalog.apps.find((app) => app.slug === slug)?.name ?? null);
    return <FeaturedCard item={catalog.featured} appName={appName} />;
  }, [catalog.featured, catalog.apps]);
  // Every app stays in the page (and in its links); a phone hides the rest until asked.
  const [allShown, setAllShown] = useState(false);
  const showAll = useCallback(() => setAllShown(true), []);
  const clear = useCallback(() => change(""), [change]);

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
            onChange={(event) => change(event.target.value)}
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

      <AppsList
        results={results}
        query={query}
        rows={rows}
        byName={byName}
        featured={featured}
        allShown={allShown}
        onShowAll={showAll}
        onClear={clear}
      />
    </CatalogLayout>
  );
}

/**
 * The apps under the search field: the results of a search, or the rows and
 * every app by name. Its own component, so that a key press in the field
 * redraws only the field: the apps follow when the search does.
 */
const AppsList = memo(function AppsList({
  results,
  query,
  rows,
  byName,
  featured,
  allShown,
  onShowAll,
  onClear,
}: {
  results: SiteApp[] | null;
  query: string;
  rows: StorefrontRow[];
  byName: SiteApp[];
  featured: ReactNode;
  allShown: boolean;
  onShowAll: () => void;
  onClear: () => void;
}) {
  if (results !== null) {
    return results.length === 0 ? (
      <div className="grid justify-items-center gap-3 rounded-xl border border-fd-border border-dashed px-6 py-12 text-center">
        <p className="font-semibold text-lg">No apps match</p>
        <p className="text-fd-muted-foreground">
          Try other words, or ask for the app you are looking for.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-fd-border px-3 py-1.5 font-medium text-sm hover:bg-fd-accent"
          >
            Show all apps
          </button>
          <a
            href={suggestAppUrl(query)}
            className="rounded-md border border-fd-border px-3 py-1.5 font-medium text-sm hover:bg-fd-accent"
          >
            Suggest an app
          </a>
        </div>
      </div>
    ) : (
      <CatalogSection title="Results">
        <AppGrid apps={results} long />
      </CatalogSection>
    );
  }
  return (
    <>
      {rows.map((row, index) => (
        <Fragment key={row.id}>
          <AppRow row={row} />
          {index === 0 && featured}
        </Fragment>
      ))}
      {rows.length === 0 && featured}
      <CatalogSection title="All apps">
        <AppGrid apps={byName} phoneLimit={allShown ? undefined : PHONE_LIST_LENGTH} long />
        {!allShown && byName.length > PHONE_LIST_LENGTH && (
          <button
            type="button"
            onClick={onShowAll}
            className="justify-self-center rounded-md border border-fd-border px-4 py-2 font-medium text-sm hover:bg-fd-accent sm:hidden"
          >
            Show all {byName.length} apps
          </button>
        )}
      </CatalogSection>
    </>
  );
});
