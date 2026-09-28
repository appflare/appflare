import { Empty, LinkButton } from "@cloudflare/kumo";
import { GearIcon, LinkBreakIcon, StorefrontIcon } from "@phosphor-icons/react";
import { PageHeader } from "./page-header";
import { settingsLink } from "./settings-links";

/** Why an install link (`/install/...`) cannot open what it names. */
export type InstallLinkProblemKind =
  /** No enabled catalog lists the app, or the link does not name one. */
  | "app"
  /** The same, while the official catalog is turned off. */
  | "official-off"
  /** The link does not name a GitHub repository. */
  | "repository";

const COPY: Record<InstallLinkProblemKind, { title: string; description: string }> = {
  app: {
    title: "This app is not in your catalogs",
    description:
      "None of the catalogs this Appflare uses lists it. An admin can add the catalog that has it in Catalog settings.",
  },
  "official-off": {
    title: "This app is not in your catalogs",
    description:
      "The official catalog is turned off on this Appflare, so its apps are not listed. An admin can turn it back on in Catalog settings.",
  },
  repository: {
    title: "This link does not name a GitHub repository",
    description:
      "An install link for a repository looks like /install/github/owner/repo. Check the link, or install from a repository on the catalog page.",
  },
};

/**
 * The plain page an install link shows when it cannot open anything: what
 * went wrong, and the way to the catalog (and, for an app and an admin, to
 * Catalog settings, which only admins can change). Nothing is installed or
 * built from here.
 */
export function InstallLinkProblem({
  kind,
  isAdmin = false,
}: {
  kind: InstallLinkProblemKind;
  /** Only admins change the catalogs, so only they get the Catalog settings button. */
  isAdmin?: boolean;
}) {
  const { title, description } = COPY[kind];
  return (
    <>
      <PageHeader title="Install" parents={[{ label: "Catalog", href: "/catalog" }]} />
      <Empty
        icon={
          kind === "repository" ? (
            <LinkBreakIcon size={48} className="text-kumo-inactive" />
          ) : (
            <StorefrontIcon size={48} className="text-kumo-inactive" />
          )
        }
        title={title}
        description={description}
        contents={
          <div className="flex flex-wrap justify-center gap-2">
            <LinkButton href="/catalog" variant="primary" icon={<StorefrontIcon />}>
              Open the catalog
            </LinkButton>
            {kind !== "repository" && isAdmin && (
              <LinkButton
                href={settingsLink("catalogs", "catalogs")}
                variant="secondary"
                icon={<GearIcon />}
              >
                Catalog settings
              </LinkButton>
            )}
          </div>
        }
      />
    </>
  );
}
