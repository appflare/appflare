import { Empty, LinkButton } from "@cloudflare/kumo";
import { PackageIcon, StorefrontIcon } from "@phosphor-icons/react";
import { PageHeader } from "../components/page-header";
import type { StartUpdateHandle } from "../components/update-banner";
import type { UpdateAllOutcome } from "../installs/update-all";
import { YourApps } from "./app-cards";
import { type AccountAttentionRow, type AttentionItem, appSignals } from "./attention";
import type { HomeApp } from "./layout-data";
import { NeedsAttention } from "./needs-attention";

/**
 * Home: "Needs attention" (only when something does), then "Your apps" as
 * cards. With no app installed, an empty state that offers the catalog;
 * Home shows it only after a click on Home, since arriving at `/` goes on to
 * the catalog then (`home-landing.ts`).
 */
export function HomeView({
  apps,
  items,
  isAdmin,
  update,
  onDismissAccountRow,
  onUpdateAllOutcome,
  now,
}: {
  apps: readonly HomeApp[];
  items: readonly AttentionItem[];
  isAdmin: boolean;
  update: StartUpdateHandle;
  onDismissAccountRow(row: AccountAttentionRow): void;
  onUpdateAllOutcome(outcome: UpdateAllOutcome): void;
  now: Date;
}) {
  return (
    <>
      <PageHeader
        title="Home"
        description="What needs your attention, and the apps in this Cloudflare account."
        actions={
          apps.length > 0 ? (
            <LinkButton href="/catalog" variant="secondary" icon={<StorefrontIcon />}>
              Catalog
            </LinkButton>
          ) : undefined
        }
      />
      <NeedsAttention
        items={items}
        isAdmin={isAdmin}
        update={update}
        onDismissAccountRow={onDismissAccountRow}
        onUpdateAllOutcome={onUpdateAllOutcome}
      />
      {update.dialog}
      {apps.length > 0 ? (
        <YourApps apps={apps} signals={appSignals(items)} now={now} />
      ) : (
        <Empty
          icon={<PackageIcon size={48} className="text-kumo-inactive" />}
          title="No apps installed yet"
          description="Install an app from the catalog. It runs in this Cloudflare account, and Appflare keeps it updated."
          contents={
            <LinkButton href="/catalog" variant="primary" icon={<StorefrontIcon />}>
              Browse the catalog
            </LinkButton>
          }
        />
      )}
    </>
  );
}
