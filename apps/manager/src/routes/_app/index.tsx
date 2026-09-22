import { Empty, LinkButton } from "@cloudflare/kumo";
import { PackageIcon, StorefrontIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "../../components/page-header";

/** `/`: installed apps. No installs exist yet. */
export const Route = createFileRoute("/_app/")({
  component: InstalledPage,
});

function InstalledPage() {
  // TODO: list installs with status, version, and update-available badge.
  return (
    <>
      <PageHeader
        title="Installed apps"
        description="Apps Appflare manages in this Cloudflare account."
      />
      <Empty
        icon={<PackageIcon size={48} className="text-kumo-inactive" />}
        title="No apps installed"
        description="Install an app from the catalog. It runs in this account and Appflare keeps it updated."
        contents={
          <LinkButton href="/catalog" variant="primary" icon={<StorefrontIcon />}>
            Browse the catalog
          </LinkButton>
        }
      />
    </>
  );
}
