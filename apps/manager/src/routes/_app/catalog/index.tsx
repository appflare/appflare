import { Banner, Button, Empty, Link, Text, useKumoToastManager } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  MagnifyingGlassIcon,
  StorefrontIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  type BrowseQuery,
  browseApps,
  browseNavigation,
  browseSearchSchema,
  categoryCounts,
  showsResults,
} from "../../../catalog/browse";
import { type CatalogList, listCatalog, refreshCatalog } from "../../../catalog/catalog.functions";
import { prefilledRepository } from "../../../catalog/install-intent";
import { UNSIGNED_INDEX_REFUSAL } from "../../../catalog/sources";
import {
  filterPills,
  knowsAddedDates,
  resultsTitle,
  sinceDay,
  storefrontRows,
} from "../../../catalog/storefront";
import { BusyButton } from "../../../components/busy-button";
import { CatalogAddMenu } from "../../../components/catalog-add-menu";
import { AppGrid, AppRow, CatalogSection } from "../../../components/catalog-row";
import { CatalogSearch, useSearchText } from "../../../components/catalog-search";
import { CategoryCards } from "../../../components/category-cards";
import { FeaturedCard } from "../../../components/featured-card";
import { formatExactDateTime } from "../../../components/format";
import { plainMessage } from "../../../components/message-links";
import { MessageLinkButtons, MessageText } from "../../../components/message-text";
import { PageHeader } from "../../../components/page-header";
import { settingsLink } from "../../../components/settings-links";
import { Tooltip } from "../../../components/tooltip";
import { CATALOG_STALE_MS } from "../../../router-timing";

/**
 * `/catalog`: the apps of every enabled catalog, as a storefront. A search
 * field first, with the active filters as pills inside it, then the
 * categories as cards. Without a search or filter, rows picked for a first
 * look (new, most popular, installed here, the biggest categories) with the
 * sponsored item among them, then every app in a compact list; with one,
 * the matching apps as tiles. The search and filters live in the page
 * address (`?q=`, `?category=`, `?plan=`, `?license=`, `?installed=1`,
 * `?source=`, and `?sort=` for a row's "See all"), so any view can be shared.
 * `?repository=owner/repo` (from `/install/github/<owner>/<repo>`) opens
 * "Install from a repository" for an admin with the repository filled in.
 */
export const Route = createFileRoute("/_app/catalog/")({
  staticData: { title: "Catalog", width: "wide" },
  validateSearch: browseSearchSchema.extend({
    repository: z.string().max(200).optional().catch(undefined),
  }),
  loader: () => listCatalog(),
  staleTime: CATALOG_STALE_MS,
  component: CatalogPage,
});

function CatalogPage() {
  const catalog = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const prefill = useRepositoryLink(viewer.role === "admin");

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Apps you can add to your Cloudflare account."
        actions={
          viewer.role === "admin" ? (
            <>
              <CatalogAddMenu
                repositoryBuilds={catalog.repositoryBuilds}
                sandbox={catalog.sandbox}
                prefill={prefill ?? undefined}
              />
              <RefreshButton />
            </>
          ) : undefined
        }
      />
      {prefill !== null && !catalog.repositoryBuilds && (
        <Banner
          variant="secondary"
          icon={<WarningCircleIcon weight="fill" />}
          title={`Appflare cannot build ${prefill} on this account`}
          description={
            <MessageText
              message={catalog.sandbox.missing ?? "Building from a repository is not available."}
              newTab
            />
          }
        />
      )}
      {catalog.error === null &&
        catalog.failed.map(({ source, error }) => (
          <Banner
            key={source.id}
            variant="secondary"
            icon={<WarningCircleIcon weight="fill" />}
            title={`${source.label} could not be loaded`}
            description={`Its apps are not shown. ${error}`}
          />
        ))}
      {catalog.unsigned.map(({ source, count }) => (
        <Banner
          key={`unsigned-${source.id}`}
          variant="secondary"
          icon={<WarningCircleIcon weight="fill" />}
          title={`${count} ${count === 1 ? "app" : "apps"} from ${source.label} not shown`}
          description={UNSIGNED_INDEX_REFUSAL}
        />
      ))}
      {catalog.unreadable > 0 && (
        <Banner
          variant="secondary"
          icon={<WarningCircleIcon weight="fill" />}
          title={`${catalog.unreadable} ${catalog.unreadable === 1 ? "app" : "apps"} could not be shown`}
          description={
            <>
              The catalog lists apps this version of Appflare does not understand yet. Update
              Appflare in the{" "}
              <Link href={settingsLink("updates", "appflare")}>Updates settings</Link> to see them.
            </>
          }
        />
      )}
      {catalog.error !== null ? (
        <Empty
          icon={<WarningCircleIcon size={48} className="text-kumo-inactive" />}
          title="The catalog is unavailable"
          // Kumo's empty state takes plain text; a place the message names becomes its button.
          description={plainMessage(catalog.error)}
          contents={<MessageLinkButtons message={catalog.error} />}
        />
      ) : catalog.apps.length === 0 ? (
        <Empty
          icon={<StorefrontIcon size={48} className="text-kumo-inactive" />}
          title="No apps in the catalog yet"
          description="The list of apps was loaded but is empty."
        />
      ) : (
        <Storefront catalog={catalog} />
      )}
    </>
  );
}

/**
 * The repository a repository install link named (`?repository=`), for an
 * admin, checked again since anyone can type the address. Read once, then
 * taken out of the address, so coming back to this page or reloading it
 * does not open the dialog again.
 */
function useRepositoryLink(isAdmin: boolean): string | null {
  const { repository } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [prefill] = useState(() => (isAdmin ? prefilledRepository(repository) : null));
  useEffect(() => {
    if (repository === undefined) return;
    void navigate({
      search: ({ repository: _taken, ...rest }) => rest,
      replace: true,
      resetScroll: false,
    });
  }, [repository, navigate]);
  return prefill;
}

function Storefront({ catalog }: { catalog: CatalogList }) {
  const query = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [text, setText] = useSearchText(query.q, (q) => update({ q }, "typing"));
  // One "now" per visit, so rows and relative times do not shift while the page is open.
  const [now] = useState(() => new Date());
  const top = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const allId = useId();

  /** Typing replaces the history entry; every other change adds one, so Back undoes it. */
  function update(patch: BrowseQuery, change: "typing" | "choice" = "choice") {
    void navigate(browseNavigation(patch, change));
  }
  function clearAll() {
    void navigate({ search: {}, replace: false, resetScroll: false });
  }
  /** A row's "See all": its filter or order, with the results brought into view. */
  function seeAll(patch: BrowseQuery) {
    update(patch);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    top.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }

  const addedDates = useMemo(() => knowsAddedDates(catalog.apps), [catalog.apps]);
  const pills = filterPills(query, {
    sourceLabel: (id) => catalog.sources.find((s) => s.id === id)?.label ?? id,
    addedDates,
  });
  const results = useMemo(
    () => (showsResults(query) ? browseApps(catalog.apps, query) : null),
    [catalog.apps, query],
  );
  const rows = useMemo(
    () => (results === null ? storefrontRows(catalog.apps, now) : []),
    [catalog.apps, results, now],
  );
  const categories = useMemo(() => categoryCounts(catalog.apps), [catalog.apps]);
  const byName = useMemo(
    () => [...catalog.apps].sort((a, b) => a.name.localeCompare(b.name, "en")),
    [catalog.apps],
  );
  const featured =
    catalog.featured === null ? null : (
      <FeaturedCard key={catalog.featured.id} item={catalog.featured} />
    );

  return (
    <div ref={top} className="grid min-w-0 scroll-mt-6 grid-cols-1 gap-8">
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-1.5">
          <CatalogSearch
            text={text}
            onText={setText}
            query={query}
            pills={pills}
            sources={catalog.sources}
            onChange={update}
            onClear={clearAll}
          />
          <StatusLine
            shown={results?.length ?? null}
            total={catalog.apps.length}
            updatedAt={catalog.updatedAt}
            now={now}
          />
        </div>
        <CategoryCards
          categories={categories}
          selected={query.category}
          onSelect={(category) => update({ category })}
        />
      </div>

      {results !== null ? (
        results.length === 0 ? (
          <Empty
            icon={<MagnifyingGlassIcon size={48} className="text-kumo-inactive" />}
            title="No apps match"
            description="Try other words, or remove a filter."
            contents={<Button onClick={clearAll}>Show all apps</Button>}
          />
        ) : (
          <CatalogSection title={resultsTitle(query, addedDates)} titleId={resultsId}>
            <AppGrid apps={results} labelledBy={resultsId} />
          </CatalogSection>
        )
      ) : (
        <>
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              <AppRow
                title={row.title}
                caption={row.caption}
                apps={row.apps}
                onSeeAll={() => seeAll(row.seeAll)}
              />
              {index === 0 && featured}
            </Fragment>
          ))}
          {rows.length === 0 && featured}
          <CatalogSection title="All apps" titleId={allId}>
            <AppGrid apps={byName} labelledBy={allId} />
          </CatalogSection>
        </>
      )}
    </div>
  );
}

/** "136 apps · Updated 3 days ago" (or "12 of 136 apps" while filtered), the exact time in a tooltip. */
function StatusLine({
  shown,
  total,
  updatedAt,
  now,
}: {
  /** Apps matching the search and filters; null when there are none. */
  shown: number | null;
  total: number;
  updatedAt: string | null;
  now: Date;
}) {
  return (
    <Text as="span" variant="secondary" size="sm">
      <span className="px-1">
        <span role="status">{shown === null ? `${total} apps` : `${shown} of ${total} apps`}</span>
        {updatedAt !== null && (
          <>
            {" · "}
            <Tooltip
              content={`The list of apps was last updated ${formatExactDateTime(updatedAt)}.`}
              render={
                // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the exact time's tooltip
                <time dateTime={updatedAt} tabIndex={0} />
              }
            >
              Updated {sinceDay(updatedAt, now)}
            </Tooltip>
          </>
        )}
      </span>
    </Text>
  );
}

/** Admin only: fetch the list of apps now instead of waiting for the next scheduled refresh. */
function RefreshButton() {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [pending, setPending] = useState(false);

  async function onRefresh() {
    setPending(true);
    try {
      const { count, failed } = await refreshCatalog();
      await router.invalidate();
      toasts.add({
        title: failed.length === 0 ? "List of apps refreshed" : "List of apps partly refreshed",
        description: `Loaded ${count} app${count === 1 ? "" : "s"}.${failed.length === 0 ? "" : ` Could not refresh ${failed.join(", ")}.`}`,
        variant: failed.length === 0 ? "success" : "warning",
      });
    } catch (error) {
      toasts.add({
        title: "Could not refresh the list of apps",
        description: error instanceof Error ? error.message : undefined,
        variant: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Tooltip
      content="Refresh the list of apps"
      render={
        <BusyButton
          pending={pending}
          variant="ghost"
          shape="square"
          icon={ArrowsClockwiseIcon}
          aria-label="Refresh the list of apps"
          onClick={onRefresh}
        />
      }
    />
  );
}
