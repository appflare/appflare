import { cn, Link, Sidebar, useSidebar } from "@cloudflare/kumo";
import {
  GearIcon,
  HouseIcon,
  type Icon,
  ListChecksIcon,
  ListIcon,
  SidebarSimpleIcon,
  StorefrontIcon,
} from "@phosphor-icons/react";
import { useLocation, useMatches } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { type PendingUpdates, sidebarUpdateBadge } from "../installs/pending-updates";
import type { Viewer } from "../server/session.functions";
import { AccountMenu } from "./account-menu";
import { AppflareCard, AppflareVersion } from "./appflare-card";
import { Logo, LogoMark } from "./logo";
import { isCurrentPage, SETTINGS_PAGE_LIST } from "./navigation";
import { MOBILE_BREAKPOINT, useIsNarrow, useSidebarRail } from "./sidebar-rail";

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
 * A counted item's icon, with a dot that stands in for the count badge
 * (which Kumo hides while the sidebar is folded).
 */
function CountedIcon({ icon: IconComponent }: { icon: Icon }) {
  return (
    <span className="relative flex shrink-0">
      <IconComponent className="size-4 shrink-0 opacity-40" />
      <span
        aria-hidden
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-kumo-brand group-not-data-[state=collapsed]/sidebar:hidden"
      />
    </span>
  );
}

/**
 * Whether the sidebar is folded into its icon rail. Never on a narrow
 * screen, where it is a drawer shown in full.
 */
function useFolded(): boolean {
  const { state, isMobile } = useSidebar();
  return !isMobile && state === "collapsed";
}

/** The drawer closes when a page opens from it (Kumo leaves it open). */
function useCloseDrawerOnNavigate(pathname: string): void {
  const { isMobile, setOpenMobile } = useSidebar();
  const shown = useRef(pathname);
  useEffect(() => {
    if (shown.current === pathname) return;
    shown.current = pathname;
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);
}

function ShellHeader() {
  const { isMobile } = useSidebar();
  const folded = useFolded();
  if (folded) {
    return (
      <Sidebar.Header className="justify-center px-[11px]">
        {/* The mark, turning into the sidebar icon under the pointer or keyboard focus. */}
        <Sidebar.Trigger className="group/rail" title="Expand sidebar">
          <LogoMark size={20} className="group-hover/rail:hidden group-focus-visible/rail:hidden" />
          <SidebarSimpleIcon
            size={18}
            className="hidden group-hover/rail:block group-focus-visible/rail:block"
          />
        </Sidebar.Trigger>
      </Sidebar.Header>
    );
  }
  return (
    <Sidebar.Header className="justify-between">
      {/* The full logo alone, its mark in line with the menu's icons. */}
      <Link href="/" variant="plain" className="flex items-center rounded-md px-2.5 py-1">
        <Logo height={24} />
      </Link>
      {isMobile ? (
        <Sidebar.Close />
      ) : (
        <Sidebar.Trigger title="Collapse sidebar">
          <SidebarSimpleIcon size={18} />
        </Sidebar.Trigger>
      )}
    </Sidebar.Header>
  );
}

function ShellSidebar({ viewer, pending }: { viewer: Viewer; pending: PendingUpdates }) {
  const { pathname } = useLocation();
  const folded = useFolded();
  useCloseDrawerOnNavigate(pathname);

  return (
    <Sidebar>
      <ShellHeader />
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            {NAV.map((item) => {
              const current = isCurrent(pathname, item);
              const badge = sidebarUpdateBadge(item.href, pending);
              const subPages =
                item.href === "/settings" && current && !folded ? SETTINGS_PAGE_LIST : [];
              // Only the innermost current entry is highlighted: a settings
              // page, or Settings itself when no page in the list matches.
              const subActive = subPages.some((page) => isCurrentPage(pathname, page.href, true));
              return (
                <Sidebar.MenuItem key={item.href}>
                  <Sidebar.MenuButton
                    href={item.href}
                    icon={badge.count > 0 ? <CountedIcon icon={item.icon} /> : item.icon}
                    active={current && !subActive}
                    // Shown only while folded, when the label is hidden.
                    tooltip={badge.count > 0 ? `${item.label}: ${badge.label}` : item.label}
                  >
                    {item.label}
                    <CountBadge count={badge.count} label={badge.label} />
                  </Sidebar.MenuButton>
                  {subPages.length > 0 && (
                    // Kumo's sub-menu starts right under its parent; a small gap keeps
                    // the two apart when both are hovered or highlighted.
                    <Sidebar.MenuSub aria-label="Settings pages" className="mt-1">
                      {subPages.map((page) => (
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
      <AppflareCard
        manager={pending.manager}
        isAdmin={viewer.role === "admin"}
        collapsed={folded}
      />
      {/* Appflare's version at the start, the account menu at the end; folded, the menu carries the version. */}
      <Sidebar.Footer className={folded ? "justify-center" : "justify-between gap-3"}>
        {!folded && <AppflareVersion version={pending.manager.current} />}
        <AccountMenu viewer={viewer} version={pending.manager.current} collapsed={folded} />
      </Sidebar.Footer>
    </Sidebar>
  );
}

/** On a narrow screen: the button that opens the navigation drawer, and the logo. */
function MobileTopBar() {
  const { isMobile, openMobile } = useSidebar();
  if (!isMobile) return null;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-base px-3">
      <Sidebar.Trigger aria-label="Open navigation" aria-expanded={openMobile}>
        <ListIcon size={20} />
      </Sidebar.Trigger>
      <Link href="/" variant="plain" className="flex items-center rounded-md px-1 py-1">
        <Logo height={22} />
      </Link>
    </header>
  );
}

/**
 * Signed-in chrome: Kumo sidebar with the logo, Home, Catalog, Jobs and
 * Settings (whose pages are listed under it while one is open), Appflare's
 * own update while there is one, and a footer with the account menu and
 * Appflare's version. Home carries the count of app updates.
 *
 * On a wide screen the sidebar folds into an icon rail (the button next to
 * the logo), with each item's name as a tooltip; the choice is remembered in
 * this browser. Below 768 px it is an off-canvas drawer, opened from a top
 * bar with the logo, and closed by a page change, Escape or the backdrop.
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
  const [rail, setRail] = useSidebarRail();
  const narrow = useIsNarrow(MOBILE_BREAKPOINT);
  // The deepest page decides; see `StaticDataRouteOption.width`.
  const wide =
    useMatches({
      select: (matches) =>
        matches.findLast((m) => m.staticData.width !== undefined)?.staticData.width,
    }) === "wide";
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!narrow) setRail(open ? "expanded" : "collapsed");
    },
    [narrow, setRail],
  );

  return (
    // A definite height lets the sidebar fill the viewport; the main pane scrolls.
    <Sidebar.Provider
      defaultOpen
      collapsible="icon"
      mobileBreakpoint={MOBILE_BREAKPOINT}
      // Kumo drives its drawer from a controlled `open` as well, so the
      // remembered rail state applies to wide screens only.
      open={narrow ? undefined : rail === "expanded"}
      onOpenChange={onOpenChange}
      className="h-dvh"
    >
      <ShellSidebar viewer={viewer} pending={pending} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar />
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-6">
          <div className={cn("mx-auto grid gap-6", wide ? "max-w-[72rem]" : "max-w-5xl")}>
            {children}
          </div>
        </main>
      </div>
    </Sidebar.Provider>
  );
}
