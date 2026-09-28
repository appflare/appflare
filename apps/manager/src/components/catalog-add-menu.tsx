import { Button, DropdownMenu } from "@cloudflare/kumo";
import { BooksIcon, GitBranchIcon, PlusIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { SandboxReadiness } from "../sandbox/readiness";
import { RepositoryBuildDialog } from "./repository-build-dialog";
import { RouterAnchor } from "./router-anchor";
import { settingsLink } from "./settings-links";

/** Where "Add a catalog" goes: the Catalogs settings, at its section. */
export const ADD_CATALOG_HREF = settingsLink("catalogs", "catalogs");

/**
 * The Catalog page header's "+" (admins only; members add nothing): a menu
 * with "From a repository…", which opens the repository build dialog when
 * the account can build from a repository, and "Add a catalog", which opens
 * the Catalogs settings. The dialog stays mounted with the page and gives
 * focus back to "+" when it closes. `prefill` (a repository install link)
 * opens the dialog at once with the repository filled in.
 */
export function CatalogAddMenu({
  repositoryBuilds,
  sandbox,
  prefill,
}: {
  /** Building from a repository is offered (Workers Paid, sandbox builds possible). */
  repositoryBuilds: boolean;
  sandbox: SandboxReadiness;
  /** `owner/repo` from a repository install link, already checked; read once. */
  prefill?: string;
}) {
  const [repositoryOpen, setRepositoryOpen] = useState(repositoryBuilds && prefill !== undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          ref={trigger}
          // `title` is Kumo's tooltip on the button.
          render={
            <Button
              variant="secondary"
              shape="square"
              icon={PlusIcon}
              aria-label="Add"
              title="Add"
            />
          }
        />
        <DropdownMenu.Content align="end">
          {repositoryBuilds && (
            <DropdownMenu.Item icon={GitBranchIcon} onClick={() => setRepositoryOpen(true)}>
              From a repository…
            </DropdownMenu.Item>
          )}
          <DropdownMenu.LinkItem
            href={ADD_CATALOG_HREF}
            icon={BooksIcon}
            render={<RouterAnchor />}
            // The page changes in place, so the menu closes itself.
            closeOnClick
          >
            Add a catalog
          </DropdownMenu.LinkItem>
        </DropdownMenu.Content>
      </DropdownMenu>
      {repositoryBuilds && (
        <RepositoryBuildDialog
          sandbox={sandbox}
          open={repositoryOpen}
          onOpenChange={setRepositoryOpen}
          returnFocus={trigger}
          prefill={prefill}
        />
      )}
    </>
  );
}
