import { Link, Sidebar } from "@cloudflare/kumo";
import {
  GearIcon,
  HouseIcon,
  type Icon,
  ListChecksIcon,
  StorefrontIcon,
} from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type PendingUpdates, sidebarUpdateBadge } from "../installs/pending-updates";
import type { Viewer } from "../server/session.functions";
import { AccountMenu } from "./account-menu";
import { AppflareCard } from "./appflare-card";
import { Logo } from "./logo";
import { isCurrentPage, SETTINGS_PAGE_LIST } from "./navigation";

interface NavItem {
  href: string;
  label: string;
  icon: Icon;
  /** Also current on the pages below it, such as an app's page under Home. */
  covers?: readonly string[];
}

const NAV: readonly NavItem[] = [
  { href: "/", label: "Home", icon: HouseIcon, covers: ["/apps"] },
  { href: "/catalog", label: "Catalog", icon: StorefrontIcon },
  { href: "/jobs", label: "Jobs", icon: ListChecksIcon },
  { href: "/settings", label: "Settings", icon: GearIcon },
];

function isCurrent(pathname: string, item: NavItem): boolean {
  if (item.href === "/") {
    return (
      isCurrentPage(pathname, "/", true) ||
      (item.covers ?? []).some((c) => isCurrentPage(pathname, c, false))
    );
  }
  return isCurrentPage(pathname, item.href, false);
}

function CountBadge({ count, label }: { count: number; label: string }) {
  if (count === 0) return null;
  return (
    <Sidebar.MenuBadge title={label}>
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </Sidebar.MenuBadge>
  );
}

/**
 * Signed-in chrome: Kumo sidebar with the logo, Home, Catalog, Jobs and
 * Settings (whose pages are listed under it while one is open), Appflare's
 * own version with its update, and the account menu. Home carries the count
 * of app updates.
 */
export function AppShell({
  viewer,
  pending,
  children,
}: {
  viewer: Viewer;
  pending: PendingUpdates;
  children: ReactNode;
}) {
  const { pathname } = useLocation();

  return (
    // A definite height lets the sidebar fill the viewport; the main pane scrolls.
    <Sidebar.Provider defaultOpen collapsible="none" className="h-dvh">
      <Sidebar>
        <Sidebar.Header>
          {/* The full logo alone, its mark in line with the menu's icons. */}
          <Link href="/" variant="plain" className="flex items-center rounded-md px-2.5 py-1">
            <Logo height={24} />
          </Link>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              {NAV.map((item) => {
                const current = isCurrent(pathname, item);
                const badge = sidebarUpdateBadge(item.href, pending);
                return (
                  <Sidebar.MenuItem key={item.href}>
                    <Sidebar.MenuButton href={item.href} icon={item.icon} active={current}>
                      {item.label}
                      <CountBadge count={badge.count} label={badge.label} />
                    </Sidebar.MenuButton>
                    {item.href === "/settings" && current && (
                      <Sidebar.MenuSub aria-label="Settings pages">
                        {SETTINGS_PAGE_LIST.map((page) => (
                          <Sidebar.MenuSubButton
                            key={page.href}
                            href={page.href}
                            active={isCurrentPage(pathname, page.href, true)}
                          >
                            {page.label}
                          </Sidebar.MenuSubButton>
                        ))}
                      </Sidebar.MenuSub>
                    )}
                  </Sidebar.MenuItem>
                );
              })}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <div className="shrink-0 px-3 pb-3">
          <AppflareCard manager={pending.manager} isAdmin={viewer.role === "admin"} />
        </div>
        <Sidebar.Footer>
          <AccountMenu viewer={viewer} />
        </Sidebar.Footer>
      </Sidebar>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto grid max-w-5xl gap-6">{children}</div>
      </main>
    </Sidebar.Provider>
  );
}
