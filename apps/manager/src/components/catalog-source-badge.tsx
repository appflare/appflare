import { Badge } from "@cloudflare/kumo";
import { BookOpenIcon } from "@phosphor-icons/react";
import type { CatalogSource } from "../catalog/sources";
import { Tooltip } from "./tooltip";

/**
 * Which catalog an app comes from: the catalog's label in its colour. Every
 * page that names an app's source uses this badge, so a catalog looks the
 * same on the catalog list, an app's catalog page and an installed app's page.
 */
export function CatalogSourceBadge({ source }: { source: CatalogSource }) {
  return (
    <Tooltip
      content={
        source.official
          ? "From the official Appflare catalog, verified with the keys built into Appflare."
          : `From ${source.label}, a catalog an admin added. Its releases are verified with the key pinned for it in Settings, Catalogs.`
      }
    >
      <Badge variant={source.colour} icon={<BookOpenIcon aria-hidden />}>
        {source.label}
      </Badge>
    </Tooltip>
  );
}
