import { Badge, Button, Sidebar, Text } from "@cloudflare/kumo";
import { GearIcon, SignOutIcon, SquaresFourIcon, StorefrontIcon } from "@phosphor-icons/react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { authClient } from "../auth/client";
import { type PendingUpdates, pendingUpdatesTitle } from "../installs/pending-updates";
import type { Viewer } from "../server/session.functions";
import { Logo } from "./logo";

const NAV = [
  { href: "/", label: "Installed", icon: SquaresFourIcon, exact: true },
  { href: "/catalog", label: "Catalog", icon: StorefrontIcon, exact: false },
  { href: "/settings", label: "Settings", icon: GearIcon, exact: false },
] as const;

/**
 * The pending updates a nav item counts: app updates on Installed (where each
 * app's update starts), the Appflare update on Settings (where the
 * self-update starts).
 */
function updateBadge(href: string, pending: PendingUpdates): { count: number; label: string } {
  if (href === "/") {
    return { count: pending.apps.length, label: pendingUpdatesTitle(pending.apps.length) };
  }
  if (href === "/settings" && pending.manager !== null) {
    return { count: 1, label: `Appflare ${pending.manager.latest} is available` };
  }
  return { count: 0, label: "" };
}

/**
 * Signed-in chrome: Kumo sidebar with navigation, the viewer, and sign-out.
 * Installed and Settings carry a count of their pending updates.
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
                const badge = updateBadge(item.href, pending);
                return (
                  <Sidebar.MenuButton
                    key={item.href}
                    href={item.href}
                    icon={item.icon}
                    active={item.exact ? pathname === item.href : pathname.startsWith(item.href)}
                  >
                    {item.label}
                    {badge.count > 0 && (
                      <Sidebar.MenuBadge title={badge.label}>
                        <span aria-hidden>{badge.count}</span>
                        <span className="sr-only">{badge.label}</span>
                      </Sidebar.MenuBadge>
                    )}
                  </Sidebar.MenuButton>
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
