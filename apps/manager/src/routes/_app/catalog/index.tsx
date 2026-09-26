import { installTierSchema, planSchema } from "@appflare/schema";
import {
  Banner,
  Button,
  Empty,
  InputGroup,
  LayerCard,
  LinkButton,
  Select,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  MagnifyingGlassIcon,
  StorefrontIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CapabilitiesView } from "../../../capabilities/capabilities";
import { authorNames } from "../../../catalog/authors";
import {
  type BrowseQuery,
  browseApps,
  categoriesOf,
  categoryLabel,
  isFiltered,
  SORTS,
  type Sort,
} from "../../../catalog/browse";
import {
  type CatalogListItem,
  listCatalog,
  refreshCatalog,
} from "../../../catalog/catalog.functions";
import { UNSIGNED_INDEX_REFUSAL } from "../../../catalog/sources";
import {
  AvailabilityLegend,
  InstallCheckBadge,
  InstalledBadge,
  PlanBadge,
  PrimitiveIcons,
  TierBadge,
} from "../../../components/catalog-badges";
import { AppIcon, PopularityLine } from "../../../components/catalog-media";
import { CatalogSourceBadge } from "../../../components/catalog-source-badge";
import { FeaturedCard } from "../../../components/featured-card";
import { PageHeader } from "../../../components/page-header";
import { RepositoryBuildButton } from "../../../components/repository-build-dialog";
import { Timestamp } from "../../../components/timestamp";

/** A search parameter that is dropped, not an error, when a link carries a value this page does not know. */
function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const searchSchema = z.object({
  q: lenient(z.string().max(200)),
  installed: lenient(z.enum(["yes", "no"])),
  plan: lenient(planSchema),
  tier: lenient(installTierSchema),
  category: lenient(z.string().min(1).max(60)),
  source: lenient(z.string().min(1).max(64)),
  sort: lenient(z.enum(["popular", "name", "checked"])),
});

/**
 * `/catalog`: apps from every enabled catalog's KV-cached `index.json`, with
 * a search over names, summaries, authors and primitives, filters for
 * installed, plan, tier, category and (with more than one catalog) source,
 * and a sort; all kept in the URL so a filtered list can be shared. Each
 * card carries its catalog's source badge when there is more than one.
 * The sponsored item (if any) sits above the list. Every card has the same
 * slots in the same order so apps can be compared down a column.
 */
export const Route = createFileRoute("/_app/catalog/")({
  staticData: { title: "Catalog" },
  validateSearch: searchSchema,
  loader: () => listCatalog(),
  component: CatalogPage,
});

const ANY = "any";

const INSTALLED_ITEMS = { [ANY]: "All apps", yes: "Installed", no: "Not installed" };
const PLAN_ITEMS = { [ANY]: "Any plan", free: "Free plan", paid: "Workers Paid" };
const TIER_ITEMS = {
  [ANY]: "Any build",
  artifact: "Signed release",
  sandbox: "Built in your account",
  "self-deploying": "Self-deploying",
};

function CatalogPage() {
  const catalog = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [text, setText] = useSearchText(search.q, (q) => update({ q }));
  const hasStats = catalog.statsGeneratedAt !== null;
  const sort: Sort = search.sort ?? (hasStats ? "popular" : "name");
  const query: BrowseQuery = { ...search, sort };
  const apps = browseApps(catalog.apps, query, hasStats);
  const filtered = isFiltered(query);
  const categories = categoriesOf(catalog.apps);
  // With one catalog there is nothing to tell apart.
  const manySources = catalog.sources.length > 1;

  function update(patch: Partial<BrowseQuery>) {
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
      resetScroll: false,
    });
  }
  function clearFilters() {
    void navigate({ search: { sort: search.sort }, replace: true, resetScroll: false });
  }
  const sortItems: Partial<Record<Sort, string>> = hasStats
    ? SORTS
    : { name: SORTS.name, checked: SORTS.checked };

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Cloudflare-native apps you can install into this account."
        actions={
          viewer.role === "admin" ? (
            <div className="flex flex-wrap items-center gap-2">
              {catalog.repositoryBuilds && <RepositoryBuildButton sandbox={catalog.sandbox} />}
              <RefreshButton />
            </div>
          ) : undefined
        }
      />
      {catalog.featured !== null && (
        <FeaturedCard key={catalog.featured.id} item={catalog.featured} />
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
          title={`${catalog.unreadable} ${catalog.unreadable === 1 ? "entry" : "entries"} could not be read`}
          description="The catalog lists apps this version of Appflare does not understand yet. Update Appflare in Settings to see them."
        />
      )}
      {catalog.error !== null ? (
        <Empty
          icon={<WarningCircleIcon size={48} className="text-kumo-inactive" />}
          title="The catalog is unavailable"
          description={catalog.error}
        />
      ) : catalog.apps.length === 0 ? (
        <Empty
          icon={<StorefrontIcon size={48} className="text-kumo-inactive" />}
          title="No apps in the catalog yet"
          description="The catalog index was loaded but lists no apps."
        />
      ) : (
        <>
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <InputGroup className="min-w-64 flex-1">
                <InputGroup.Addon>
                  <MagnifyingGlassIcon />
                </InputGroup.Addon>
                <InputGroup.Input
                  type="search"
                  value={text}
                  placeholder="Search apps, authors, services"
                  aria-label="Search apps"
                  onChange={(e) => setText(e.target.value)}
                />
                {text !== "" && (
                  <InputGroup.Addon align="end" className="pr-1">
                    <InputGroup.Button
                      shape="square"
                      icon={XIcon}
                      aria-label="Clear search"
                      onClick={() => setText("")}
                    />
                  </InputGroup.Addon>
                )}
              </InputGroup>
              <Select
                aria-label="Installed"
                value={search.installed ?? ANY}
                items={INSTALLED_ITEMS}
                onValueChange={(value) =>
                  update({ installed: value === "yes" || value === "no" ? value : undefined })
                }
              />
              <Select
                aria-label="Plan"
                value={search.plan ?? ANY}
                items={PLAN_ITEMS}
                onValueChange={(value) =>
                  update({ plan: value === "free" || value === "paid" ? value : undefined })
                }
              />
              <Select
                aria-label="How it is built"
                value={search.tier ?? ANY}
                items={TIER_ITEMS}
                onValueChange={(value) => {
                  const tier = installTierSchema.safeParse(value);
                  update({ tier: tier.success ? tier.data : undefined });
                }}
              />
              {manySources && (
                <Select
                  aria-label="Source"
                  value={search.source ?? ANY}
                  items={{
                    [ANY]: "All catalogs",
                    ...Object.fromEntries(catalog.sources.map((s) => [s.id, s.label])),
                  }}
                  onValueChange={(value) =>
                    update({
                      source: typeof value === "string" && value !== ANY ? value : undefined,
                    })
                  }
                />
              )}
              {categories.length > 0 && (
                <Select
                  aria-label="Category"
                  value={search.category ?? ANY}
                  items={{
                    [ANY]: "All categories",
                    ...Object.fromEntries(categories.map((c) => [c, categoryLabel(c)])),
                  }}
                  onValueChange={(value) =>
                    update({
                      category: typeof value === "string" && value !== ANY ? value : undefined,
                    })
                  }
                />
              )}
              <Select
                aria-label="Sort apps"
                value={sort}
                items={sortItems}
                renderValue={(value) => `Sort: ${SORTS[value as Sort] ?? SORTS.name}`}
                onValueChange={(value) => {
                  const next = z.enum(["popular", "name", "checked"]).safeParse(value);
                  update({ sort: next.success ? next.data : undefined });
                }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                <Text as="span" variant="secondary" size="sm">
                  {filtered
                    ? `${apps.length} of ${catalog.apps.length} apps`
                    : `${catalog.apps.length} apps`}
                  {catalog.updatedAt !== null && (
                    <>
                      {" "}
                      · catalog updated <Timestamp iso={catalog.updatedAt} />
                    </>
                  )}
                </Text>
                {filtered && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </span>
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                <Text as="span" variant="secondary" size="sm">
                  Services on this account:
                </Text>
                <AvailabilityLegend />
              </span>
            </div>
          </div>
          {apps.length === 0 ? (
            <Empty
              icon={<MagnifyingGlassIcon size={48} className="text-kumo-inactive" />}
              title="No apps match"
              description="Try other words, or clear the filters to see every app."
              contents={<Button onClick={clearFilters}>Clear filters</Button>}
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {apps.map((app) => (
                <AppCard
                  key={app.key}
                  app={app}
                  capabilities={catalog.capabilities}
                  showSource={manySources}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * The search box's text: the URL's `q`, so back and forward bring the words
 * back, and while someone types, their own draft (every keystroke replaces
 * `q`, and a navigation still in flight must not overwrite newer letters).
 * A `q` the box did not write itself (back, forward, Clear filters) drops
 * the draft.
 */
function useSearchText(
  q: string | undefined,
  write: (q: string | undefined) => void,
): [string, (text: string) => void] {
  const [draft, setDraft] = useState<string | null>(null);
  // Values the box wrote that the URL has not reached yet, and the newest one.
  const inFlight = useRef(new Set<string>());
  const latest = useRef<string | null>(null);
  useEffect(() => {
    const current = q ?? "";
    if (current === latest.current) {
      inFlight.current.clear();
      latest.current = null;
      return;
    }
    if (inFlight.current.has(current)) return;
    inFlight.current.clear();
    latest.current = null;
    setDraft(null);
  }, [q]);
  function type(text: string) {
    const next = text.trim() === "" ? undefined : text;
    inFlight.current.add(next ?? "");
    latest.current = next ?? "";
    setDraft(text);
    write(next);
  }
  return [draft ?? q ?? "", type];
}

/**
 * One app, with the same slots in the same order on every card: header
 * (icon or monogram, name, tier and plan), summary (two lines), meta
 * (authors, version), status (install check, popularity), primitives
 * (always), and a footer with the installed state and the one action.
 */
function AppCard({
  app,
  capabilities,
  showSource,
}: {
  app: CatalogListItem;
  capabilities: CapabilitiesView | null;
  /** Show the catalog's source badge (there is more than one catalog). */
  showSource: boolean;
}) {
  const authors = app.authors === undefined ? "" : authorNames(app.authors);
  return (
    <LayerCard className="flex h-full flex-col">
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <AppIcon src={app.images.icon} name={app.name} size={28} />
          <Text as="h2" bold>
            {app.name}
          </Text>
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <TierBadge tier={app.tier} />
          <PlanBadge plan={app.plan} />
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="grid gap-1">
          <Text>
            <span className="line-clamp-2 min-h-[2lh]" title={app.summary}>
              {app.summary}
            </span>
          </Text>
          <Text variant="secondary" size="sm" truncate>
            {authors !== "" && <>By {authors} · </>}
            <span className="font-mono text-[0.9em]">{app.version}</span>
          </Text>
        </div>
        <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-2">
          {showSource && <CatalogSourceBadge source={app.source} />}
          <InstallCheckBadge lastVerified={app.lastVerified} />
          <PopularityLine popularity={app.popularity} />
        </div>
        <PrimitiveIcons primitives={app.primitives} capabilities={capabilities} tier={app.tier} />
        <div className="mt-auto flex items-center justify-between gap-3 pt-1">
          <InstalledBadge instances={app.instances} />
          <LinkButton
            href={`/catalog/${app.key}`}
            variant="secondary"
            icon={<ArrowRightIcon />}
            className="ml-auto"
            aria-label={`Details of ${app.name}`}
          >
            Details
          </LinkButton>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** Admin only: re-fetch `index.json` now instead of waiting for the cron; a toast says how it went. */
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
        title: failed.length === 0 ? "Catalog refreshed" : "Catalog partly refreshed",
        description: `Loaded ${count} app${count === 1 ? "" : "s"}.${failed.length === 0 ? "" : ` Could not refresh ${failed.join(", ")}.`}`,
        variant: failed.length === 0 ? "success" : "warning",
      });
    } catch (error) {
      toasts.add({
        title: "Could not refresh the catalog",
        description: error instanceof Error ? error.message : undefined,
        variant: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="secondary"
      icon={<ArrowsClockwiseIcon />}
      loading={pending}
      onClick={onRefresh}
    >
      Refresh
    </Button>
  );
}
