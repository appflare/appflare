import {
  Badge,
  Banner,
  Button,
  Empty,
  LayerCard,
  LinkButton,
  Select,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  StorefrontIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import type { CapabilitiesView } from "../../../capabilities/capabilities";
import { authorNames } from "../../../catalog/authors";
import {
  type CatalogListItem,
  listCatalog,
  refreshCatalog,
} from "../../../catalog/catalog.functions";
import { sortByPopularity } from "../../../catalog/popularity";
import {
  InstallCheckBadge,
  PlanBadge,
  RequirementIcons,
  TierBadge,
} from "../../../components/catalog-badges";
import { AppIcon, PopularityLine } from "../../../components/catalog-media";
import { FeaturedCard } from "../../../components/featured-card";
import { PageHeader } from "../../../components/page-header";
import { StatusBadge } from "../../../components/status-badge";
import { Timestamp } from "../../../components/timestamp";

const SORTS = { popular: "Most popular", name: "Name" } as const;
type Sort = keyof typeof SORTS;

/**
 * `/catalog`: apps from the KV-cached `index.json`, most popular first when
 * the catalog publishes recent popularity numbers, and the sponsored item
 * (if any) above the list.
 */
export const Route = createFileRoute("/_app/catalog/")({
  staticData: { title: "Catalog" },
  validateSearch: z.object({ sort: z.enum(["popular", "name"]).optional() }),
  loader: () => listCatalog(),
  component: CatalogPage,
});

/** The apps in the chosen order; "popular" without recent numbers keeps the index order. */
function sortedApps(apps: CatalogListItem[], sort: Sort, hasStats: boolean): CatalogListItem[] {
  if (sort === "name") return [...apps].sort((a, b) => a.name.localeCompare(b.name));
  return hasStats ? sortByPopularity(apps) : apps;
}

function CatalogPage() {
  const catalog = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const hasStats = catalog.statsGeneratedAt !== null;
  const sort: Sort = search.sort ?? "popular";
  const apps = sortedApps(catalog.apps, sort, hasStats);
  return (
    <>
      <PageHeader
        title="Catalog"
        description="Cloudflare-native apps you can install into this account."
        actions={viewer.role === "admin" ? <RefreshButton /> : undefined}
      />
      {(catalog.updatedAt !== null || hasStats) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Text variant="secondary" size="sm">
            {catalog.updatedAt !== null && (
              <>
                Catalog updated <Timestamp iso={catalog.updatedAt} />.
              </>
            )}
          </Text>
          {hasStats && (
            <Select
              aria-label="Sort apps"
              value={sort}
              onValueChange={(value) =>
                void navigate({ search: { sort: value === "name" ? "name" : "popular" } })
              }
              items={SORTS}
              renderValue={(value) => `Sort: ${SORTS[value === "name" ? "name" : "popular"]}`}
            />
          )}
        </div>
      )}
      {catalog.featured !== null && (
        <FeaturedCard key={catalog.featured.id} item={catalog.featured} />
      )}
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
        <div className="grid gap-4 md:grid-cols-2">
          {apps.map((app) => (
            <AppCard key={app.slug} app={app} capabilities={catalog.capabilities} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * One app: icon and name (never cut short; the badges wrap below a long
 * name), summary, authors, version, checks, and the way to its page. Cards
 * in a row are as tall as the tallest, with their actions at the bottom.
 */
function AppCard({
  app,
  capabilities,
}: {
  app: CatalogListItem;
  capabilities: CapabilitiesView | null;
}) {
  return (
    <LayerCard className="flex h-full flex-col">
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="flex min-w-0 items-center gap-3">
          <AppIcon src={app.images.icon} size={28} />
          <Text as="h2" bold>
            {app.name}
          </Text>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {app.tier !== "artifact" && <TierBadge tier={app.tier} />}
          <PlanBadge plan={app.plan} />
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-1 flex-col gap-4 px-5 py-4">
        <div className="grid gap-1.5">
          <Text>{app.summary}</Text>
          {app.authors !== undefined && (
            <Text variant="secondary" size="sm">
              By {authorNames(app.authors)}
            </Text>
          )}
          <Text variant="secondary" size="sm">
            Version <span className="font-mono text-[0.9em]">{app.version}</span>
          </Text>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <InstallCheckBadge lastVerified={app.lastVerified} />
          <PopularityLine popularity={app.popularity} />
          <RequirementIcons requires={app.requires} capabilities={capabilities} />
        </div>
        <div className="mt-auto flex items-center justify-between gap-3">
          <InstancesBadge instances={app.instances} />
          <LinkButton href={`/catalog/${app.slug}`} variant="secondary" icon={<ArrowRightIcon />}>
            {app.instances.length > 0 ? "Details" : "View and install"}
          </LinkButton>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** One install shows its status; several show how many there are. */
function InstancesBadge({ instances }: { instances: CatalogListItem["instances"] }) {
  const [only] = instances;
  if (only === undefined) return <span />;
  if (instances.length === 1) return <StatusBadge status={only.status} of="install" />;
  return <Badge variant="neutral">{instances.length} installs</Badge>;
}

/** Admin only: re-fetch `index.json` now instead of waiting for the cron; a toast says how it went. */
function RefreshButton() {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [pending, setPending] = useState(false);

  async function onRefresh() {
    setPending(true);
    try {
      const { count } = await refreshCatalog();
      await router.invalidate();
      toasts.add({
        title: "Catalog refreshed",
        description: `Loaded ${count} app${count === 1 ? "" : "s"}.`,
        variant: "success",
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
