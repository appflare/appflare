import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "../../components/page-header";
import { PlaceholderCard } from "../../components/placeholder-card";

/** `/catalog`. */
export const Route = createFileRoute("/_app/catalog")({
  component: CatalogPage,
});

function CatalogPage() {
  // TODO: catalog list from the KV-cached index.json, and /catalog/$slug.
  return (
    <>
      <PageHeader title="Catalog" description="Cloudflare-native apps you can install." />
      <PlaceholderCard
        title="App catalog"
        description="Browsing and installing apps from the Appflare catalog."
      />
    </>
  );
}
