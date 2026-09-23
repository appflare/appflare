import { Badge, Banner, Button, Empty, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  StorefrontIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  type CatalogListItem,
  listCatalog,
  refreshCatalog,
} from "../../../catalog/catalog.functions";
import { formatDateTime, requirementLabel } from "../../../components/format";
import { PageHeader } from "../../../components/page-header";
import { PlanBadge, StatusBadge } from "../../../components/status-badge";

/** `/catalog`: apps from the KV-cached `index.json`. */
export const Route = createFileRoute("/_app/catalog/")({
  loader: () => listCatalog(),
  component: CatalogPage,
});

function CatalogPage() {
  const catalog = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader
        title="Catalog"
        description="Cloudflare-native apps you can install into this account."
        actions={viewer.role === "admin" ? <RefreshButton /> : undefined}
      />
      {catalog.updatedAt !== null && (
        <Text variant="secondary" size="sm">
          Catalog updated {formatDateTime(catalog.updatedAt)}.
        </Text>
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
          {catalog.apps.map((app) => (
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
        <span className="truncate">{app.name}</span>
        <PlanBadge plan={app.plan} />
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <div className="grid gap-1.5">
          <Text>{app.summary}</Text>
          <Text variant="secondary" size="sm">
            Version <span className="font-mono text-[0.9em]">{app.version}</span>
            {app.lastVerified !== null && <> · Verified {formatDateTime(app.lastVerified)}</>}
          </Text>
        </div>
        {app.requires.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {app.requires.map((r) => (
              <Badge key={r} variant="outline">
                Requires {requirementLabel(r)}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          {app.installed !== null ? (
            <StatusBadge status={app.installed.status} of="install" />
          ) : (
            <span />
          )}
          <LinkButton href={`/catalog/${app.slug}`} variant="secondary" icon={<ArrowRightIcon />}>
            {app.installed !== null ? "Details" : "View and install"}
          </LinkButton>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
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
