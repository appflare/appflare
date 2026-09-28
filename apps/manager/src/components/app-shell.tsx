import { cn, Link, Sidebar, useSidebar } from "@cloudflare/kumo";
import {
  HouseIcon,
  type Icon,
  ListChecksIcon,
  ListIcon,
  SidebarSimpleIcon,
  StorefrontIcon,
} from "@phosphor-icons/react";
import { useLocation, useMatches, useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { useHomeClick } from "../home/use-attention";
import type { ManagerStatus } from "../installs/pending-updates";
import type { Viewer } from "../server/session.functions";
import { AccountMenu } from "./account-menu";
import { AppflareCard, AppflareVersion } from "./appflare-card";
import { Logo, LogoMark } from "./logo";
import { isCurrentPage, type SettingsPage, visibleSettingsPages } from "./navigation";
import { type SettingsNavigation, SettingsNavigationContext } from "./settings-menu";
import { SettingsNavItem } from "./settings-nav";
import { SidebarAppsGroup } from "./sidebar-apps";
import type { SidebarApp } from "./sidebar-apps-list";
import { MOBILE_BREAKPOINT, useIsNarrow, useSidebarRail } from "./sidebar-rail";
import { useHashTarget } from "./use-hash-target";

interface NavItem {
  href: string;
  label: string;
  icon: Icon;
  /**
   * Also current on the pages below it: an app's page is under Home while
   * the sidebar lists no apps (such as the page of a removed app).
   */
  covers?: readonly string[];
}

const NAV: readonly NavItem[] = [
  { href: "/", label: "Home", icon: HouseIcon, covers: ["/apps"] },
  { href: "/catalog", label: "Catalog", icon: StorefrontIcon },
  { href: "/jobs", label: "Jobs", icon: ListChecksIcon },
];

function isCurrent(pathname: string, item: NavItem, appsListed: boolean): boolean {
  if (item.href === "/") {
    return (
      isCurrentPage(pathname, "/", true) ||
      (!appsListed && (item.covers ?? []).some((c) => isCurrentPage(pathname, c, false)))
    );
  }
  return isCurrentPage(pathname, item.href, false);
}

/** The count on the sidebar's Home item: the "Needs attention" rows. */
export interface NavBadge {
  count: number;
  label: string;
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
  const onHomeClick = useHomeClick();
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
      {/* The full logo alone, its mark in line with the menu's icons; the mark plays the loading motion once on hover. */}
      <Link
        href="/"
        variant="plain"
        className="flex items-center rounded-md px-2.5 py-1"
        onClick={onHomeClick}
      >
        <Logo height={24} morphOnHover />
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

function ShellSidebar({
  viewer,
  manager,
  apps,
  badge,
  settingsPages,
}: {
  viewer: Viewer;
  manager: ManagerStatus;
  apps: readonly SidebarApp[];
  badge: NavBadge;
  settingsPages: readonly SettingsPage[];
}) {
  const { pathname } = useLocation();
  const folded = useFolded();
  const onHomeClick = useHomeClick();
  useCloseDrawerOnNavigate(pathname);
  // In the folded rail too, as icons.
  const appsListed = apps.length > 0;

  return (
    <Sidebar>
      <ShellHeader />
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            {NAV.map((item) => {
              // Only Home carries a count: what needs attention.
              const count = item.href === "/" ? badge.count : 0;
              return (
                <Sidebar.MenuButton
                  key={item.href}
                  href={item.href}
                  icon={count > 0 ? <CountedIcon icon={item.icon} /> : item.icon}
                  active={isCurrent(pathname, item, appsListed)}
                  // Shown only while folded, when the label is hidden.
                  tooltip={count > 0 ? `${item.label}: ${badge.label}` : item.label}
                  {...(item.href === "/" ? { onClick: onHomeClick } : {})}
                >
                  {item.label}
                  <CountBadge count={count} label={badge.label} />
                </Sidebar.MenuButton>
              );
            })}
            <SettingsNavItem pathname={pathname} pages={settingsPages} folded={folded} />
          </Sidebar.Menu>
        </Sidebar.Group>
        {appsListed && <SidebarAppsGroup apps={apps} pathname={pathname} folded={folded} />}
      </Sidebar.Content>
      <AppflareCard manager={manager} isAdmin={viewer.role === "admin"} collapsed={folded} />
      {/* Appflare's version at the start, the account menu at the end; folded, the menu carries the version. */}
      <Sidebar.Footer className={folded ? "justify-center" : "justify-between gap-3"}>
        {!folded && <AppflareVersion version={manager.current} />}
        <AccountMenu viewer={viewer} version={manager.current} collapsed={folded} />
      </Sidebar.Footer>
    </Sidebar>
  );
}

/** On a narrow screen: the button that opens the navigation drawer, and the logo. */
function MobileTopBar() {
  const { isMobile, openMobile } = useSidebar();
  const onHomeClick = useHomeClick();
  if (!isMobile) return null;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-base px-3">
      <Sidebar.Trigger aria-label="Open navigation" aria-expanded={openMobile}>
        <ListIcon size={20} />
      </Sidebar.Trigger>
      <Link
        href="/"
        variant="plain"
        className="flex items-center rounded-md px-1 py-1"
        onClick={onHomeClick}
      >
        <Logo height={22} />
      </Link>
    </header>
  );
}

/**
 * Signed-in chrome: Kumo sidebar with the logo, Home, Catalog, Jobs and
 * Settings (a list of its pages that opens in place, `settings-nav.tsx`),
 * then "Your apps" (`sidebar-apps.tsx`), Appflare's own update while there
 * is one, and a footer with the account menu and Appflare's version. Home
 * carries the count of what needs attention, and each app its status dot.
 *
 * On a wide screen the sidebar folds into an icon rail (the button next to
 * the logo), with each item's name as a tooltip and the apps as their icons;
 * the choice is remembered in this browser. Below 768 px it is an off-canvas drawer, opened from a top
 * bar with the logo, and closed by a page change, Escape or the backdrop.
 */
export function AppShell({
  viewer,
  manager,
  removedApps,
  apps,
  badge,
  children,
}: {
  viewer: Viewer;
  manager: ManagerStatus;
  /** The installs, by name, each with its status dot. */
  apps: readonly SidebarApp[];
  badge: NavBadge;
  /** How many uninstalled apps keep data: Settings lists Removed apps only while there are any. */
  removedApps: number;
  children: ReactNode;
}) {
  const [rail, setRail] = useSidebarRail();
  const router = useRouter();
  const { pathname } = useLocation();
  const settingsPages = useMemo(
    () => visibleSettingsPages(removedApps, pathname),
    [removedApps, pathname],
  );
  const settingsNavigation = useMemo<SettingsNavigation>(
    () => ({
      pages: settingsPages,
      navigate: (href) => void router.navigate({ href }),
    }),
    [settingsPages, router],
  );
  useHashTarget();
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
      <ShellSidebar
        viewer={viewer}
        manager={manager}
        apps={apps}
        badge={badge}
        settingsPages={settingsPages}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar />
        {/* `relative`: the page's absolutely placed parts (visually hidden labels
            among them) are placed within this scrolling pane. Placed within
            Kumo's sidebar wrapper instead, one far down a long page reached
            past the viewport and gave the whole document a second scrollbar. */}
        <main className="relative min-w-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-6">
          {/* One column as wide as the pane at most: wide content (a strip of
              screenshots, a table) scrolls inside itself, never the page sideways. */}
          <div
            className={cn(
              "mx-auto grid grid-cols-[minmax(0,1fr)] gap-6",
              wide ? "max-w-[72rem]" : "max-w-5xl",
            )}
          >
            <SettingsNavigationContext.Provider value={settingsNavigation}>
              {children}
            </SettingsNavigationContext.Provider>
          </div>
        </main>
      </div>
    </Sidebar.Provider>
  );
}
