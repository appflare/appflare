import { DropdownMenu, Select, Sidebar } from "@cloudflare/kumo";
import { GearIcon } from "@phosphor-icons/react";
import { currentSettingsPage, isSettingsPath, type SettingsPage } from "./navigation";
import { useSettingsMenu, useSettingsNavigation } from "./settings-menu";

/**
 * Settings in the sidebar. Expanded, it is Kumo's collapsible menu item: a
 * click on Settings opens or closes the list of settings pages in place,
 * without leaving the page (`settings-menu.ts` remembers the choice and
 * opens the list on the settings pages). Folded into the icon rail, where
 * there is no room for the list, the gear opens a menu of the same pages.
 */
export function SettingsNavItem({
  pathname,
  pages,
  folded,
}: {
  pathname: string;
  /** The pages to list (`visibleSettingsPages`). */
  pages: readonly SettingsPage[];
  folded: boolean;
}) {
  const [open, setOpen] = useSettingsMenu(pathname);
  const onSettings = isSettingsPath(pathname);
  const current = currentSettingsPage(pages, pathname);
  if (folded) return <SettingsRailMenu pages={pages} current={current} active={onSettings} />;
  return (
    <Sidebar.MenuItem>
      <Sidebar.Collapsible open={open} onOpenChange={setOpen}>
        <Sidebar.CollapsibleTrigger
          render={
            // Highlighted while you are in Settings and the list that would
            // show the page is closed.
            <Sidebar.MenuButton icon={GearIcon} active={onSettings && (!open || current === null)}>
              Settings
              <Sidebar.MenuChevron />
            </Sidebar.MenuButton>
          }
        />
        <Sidebar.CollapsibleContent>
          {/* Kumo's sub-menu starts right under its parent; a small gap keeps
              the two apart when both are hovered or highlighted. */}
          <Sidebar.MenuSub aria-label="Settings pages" className="mt-1">
            {pages.map((page) => (
              <Sidebar.MenuSubButton
                key={page.href}
                href={page.href}
                active={page === current}
                aria-current={page === current ? "page" : undefined}
              >
                {page.label}
              </Sidebar.MenuSubButton>
            ))}
          </Sidebar.MenuSub>
        </Sidebar.CollapsibleContent>
      </Sidebar.Collapsible>
    </Sidebar.MenuItem>
  );
}

/** The folded rail's Settings: the gear opens a menu of the settings pages, the current one ticked. */
function SettingsRailMenu({
  pages,
  current,
  active,
}: {
  pages: readonly SettingsPage[];
  current: SettingsPage | null;
  active: boolean;
}) {
  return (
    <Sidebar.MenuItem>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Sidebar.MenuButton
              icon={GearIcon}
              active={active}
              aria-label="Settings"
              // Its name under the pointer, like the rail's other items.
              tooltip="Settings"
            >
              Settings
            </Sidebar.MenuButton>
          }
        />
        {/* The rail is at the window's left edge: the menu opens to its right,
            8 px clear of the rail's edge, which is 12 px past the gear. */}
        <DropdownMenu.Content side="right" align="start" sideOffset={20} className="min-w-52">
          <DropdownMenu.Group>
            <DropdownMenu.Label>Settings</DropdownMenu.Label>
            {pages.map((page) => (
              <DropdownMenu.Item
                key={page.href}
                // A link through the app's router (Kumo's link provider).
                href={page.href}
                selected={page === current}
                aria-current={page === current ? "page" : undefined}
              >
                {/* Takes the room, so the tick of the page open sits at the right. */}
                <span className="flex-1">{page.label}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu>
    </Sidebar.MenuItem>
  );
}

/**
 * On narrow screens, where the sidebar is a drawer, the settings pages show
 * this list of pages under their title, to move between them without
 * opening the drawer. Hidden from 768 px, where the sidebar lists them.
 */
export function SettingsPageSelect({ href }: { href: string }) {
  const navigation = useSettingsNavigation();
  if (navigation === null) return null;
  const { pages, navigate } = navigation;
  return (
    <div className="md:hidden">
      <Select
        aria-label="Settings page"
        className="w-full"
        value={href}
        onValueChange={(next) => {
          if (typeof next === "string" && next !== href) navigate(next);
        }}
        items={pages.map((page) => ({ value: page.href, label: page.label }))}
      />
    </div>
  );
}
