import {
  Badge,
  Banner,
  Button,
  Empty,
  LayerCard,
  LinkButton,
  Select,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  StorefrontIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
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
import { formatDateTime } from "../../../components/format";
import { PageHeader } from "../../../components/page-header";
import { StatusBadge } from "../../../components/status-badge";

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
            {catalog.updatedAt !== null && `Catalog updated ${formatDateTime(catalog.updatedAt)}.`}
          </Text>
          {hasStats && (
            <Select
              label="Sort by"
              value={sort}
              onValueChange={(value) =>
                void navigate({ search: { sort: value === "name" ? "name" : "popular" } })
              }
              items={SORTS}
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
            <AppCard key={app.slug} app={app} />
          ))}
        </div>
      )}
    </>
  );
}

function AppCard({ app }: { app: CatalogListItem }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <AppIcon src={app.images.icon} size={28} />
          <span className="truncate">{app.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {app.tier !== "artifact" && <TierBadge tier={app.tier} />}
          <PlanBadge plan={app.plan} />
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
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
          <RequirementIcons requires={app.requires} />
        </div>
        <div className="flex items-center justify-between gap-3">
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

/** Admin only: re-fetch `index.json` now instead of waiting for the cron. */
function RefreshButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function onRefresh() {
    setPending(true);
    setResult(null);
    try {
      const { count } = await refreshCatalog();
      setResult({ ok: true, message: `Loaded ${count} app${count === 1 ? "" : "s"}.` });
      await router.invalidate();
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Could not refresh the catalog.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid justify-items-end gap-2">
      <Button
        variant="secondary"
        icon={<ArrowsClockwiseIcon />}
        loading={pending}
        onClick={onRefresh}
      >
        Refresh
      </Button>
      {result !== null && (
        <Banner
          size="sm"
          variant={result.ok ? "default" : "error"}
          icon={result.ok ? <CheckCircleIcon weight="fill" /> : <WarningCircleIcon weight="fill" />}
          title={result.message}
        />
      )}
    </div>
  );
}
