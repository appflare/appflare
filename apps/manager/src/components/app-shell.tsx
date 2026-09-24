import { Badge, Button, Sidebar, Text } from "@cloudflare/kumo";
import {
  GearIcon,
  HouseIcon,
  type Icon,
  ListChecksIcon,
  SignOutIcon,
  StorefrontIcon,
} from "@phosphor-icons/react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { authClient } from "../auth/client";
import {
  MANAGER_UPDATES_HREF,
  type PendingUpdates,
  pendingUpdatesTitle,
} from "../installs/pending-updates";
import type { Viewer } from "../server/session.functions";
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

/**
 * A count of pending updates on a nav item: app updates on Home (where each
 * app's update starts), the Appflare update on Settings and its Appflare
 * updates page (where the self-update starts).
 */
function updateBadge(href: string, pending: PendingUpdates): { count: number; label: string } {
  if (href === "/") {
    return { count: pending.apps.length, label: pendingUpdatesTitle(pending.apps.length) };
  }
  if ((href === "/settings" || href === MANAGER_UPDATES_HREF) && pending.manager !== null) {
    return { count: 1, label: `Appflare ${pending.manager.latest} is available` };
  }
  return { count: 0, label: "" };
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
 * Signed-in chrome: Kumo sidebar with Home, Catalog, Jobs and Settings (whose
 * pages are listed under it while one is open), the viewer, and sign-out.
 * Home and Settings carry a count of their pending updates.
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
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    // A definite height lets the sidebar fill the viewport; the main pane scrolls.
    <Sidebar.Provider defaultOpen collapsible="none" className="h-dvh">
      <Sidebar>
        <Sidebar.Header>
          <div className="flex items-center gap-2 px-3 py-1">
            <Logo height={20} className="text-kumo-strong" />
            <Text variant="heading" as="span">
              Appflare
            </Text>
          </div>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              {NAV.map((item) => {
                const current = isCurrent(pathname, item);
                const badge = updateBadge(item.href, pending);
                return (
                  <Sidebar.MenuItem key={item.href}>
                    <Sidebar.MenuButton href={item.href} icon={item.icon} active={current}>
                      {item.label}
                      <CountBadge count={badge.count} label={badge.label} />
                    </Sidebar.MenuButton>
                    {item.href === "/settings" && current && (
                      <Sidebar.MenuSub aria-label="Settings pages">
                        {SETTINGS_PAGE_LIST.map((page) => {
                          const pageBadge = updateBadge(page.href, pending);
                          return (
                            <Sidebar.MenuSubButton
                              key={page.href}
                              href={page.href}
                              active={isCurrentPage(pathname, page.href, true)}
                            >
                              {page.label}
                              {page.href !== "/settings" && (
                                <CountBadge count={pageBadge.count} label={pageBadge.label} />
                              )}
                            </Sidebar.MenuSubButton>
                          );
                        })}
                      </Sidebar.MenuSub>
                    )}
                  </Sidebar.MenuItem>
                );
              })}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer>
          {/* The footer is one 48px row: who is signed in, and sign-out. */}
          <div className="flex min-w-0 flex-1 items-center gap-2" title={viewer.name}>
            <Text size="sm" truncate>
              {viewer.email}
            </Text>
            <Badge variant={viewer.role === "admin" ? "primary" : "neutral"}>{viewer.role}</Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<SignOutIcon />}
            aria-label="Sign out"
            title="Sign out"
            loading={signingOut}
            onClick={signOut}
          />
        </Sidebar.Footer>
      </Sidebar>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto grid max-w-5xl gap-6">{children}</div>
      </main>
    </Sidebar.Provider>
  );
}
