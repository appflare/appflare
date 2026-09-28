import { Button, cn, Input, Sidebar, Text, useSidebar } from "@cloudflare/kumo";
import { ScrollArea } from "@cloudflare/kumo/primitives/scroll-area";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { APP_SIGNAL_LABELS } from "../home/attention";
import { AppIcon } from "./catalog-media";
import {
  appItemId,
  currentAppId,
  filterApps,
  MAX_VISIBLE_APPS,
  type SidebarApp,
} from "./sidebar-apps-list";
import { StatusDot } from "./status-dot";

/**
 * The fade at the list's top and bottom edges while more rows are beyond
 * them, driven by the overflow variables Base UI's scroll area sets; the
 * same fade as Kumo's own sidebar content.
 */
const EDGE_FADE =
  "[mask-image:linear-gradient(to_bottom,transparent_0,black_min(24px,var(--scroll-area-overflow-y-start,0px)),black_calc(100%-min(24px,var(--scroll-area-overflow-y-end,0px))),transparent_100%)]";

/**
 * The sidebar's "Your apps": every install by name, each row with the app's
 * icon, what it is called here, and the dot of its most severe "Needs
 * attention" row; a row opens the app's page. At most eight rows show and
 * the rest scroll inside the group, with a thin scrollbar that appears over
 * the rows only while the pointer is on them or the list scrolls (Kumo's
 * sidebar does the same with Base UI's scroll area), and which keeps the open
 * app's row in view. The search icon beside the heading turns it into a
 * filter field (Escape clears and closes it).
 *
 * Folded into the rail, each app is its icon, the name in a tooltip and the
 * status dot on the icon's corner; the heading becomes the rail's divider
 * and the filter closes. The app shell leaves the group out while nothing is
 * installed.
 */
export function SidebarAppsGroup({
  apps,
  pathname,
  folded = false,
}: {
  /** Sorted by name (`sidebarApps`). */
  apps: readonly SidebarApp[];
  pathname: string;
  /** The sidebar is folded into its icon rail. */
  folded?: boolean;
}) {
  const { scrollItemIntoView } = useSidebar();
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState("");
  const shown = filterApps(apps, query);
  const current = currentAppId(pathname);
  const capped = apps.length > MAX_VISIBLE_APPS;

  // Kumo scrolls the nearest `data-sidebar="viewport"`: the group's own list.
  useEffect(() => {
    if (current !== null) scrollItemIntoView(appItemId(current), { align: "center" });
  }, [current, scrollItemIntoView]);

  // The rail has no room for the filter field.
  useEffect(() => {
    if (!folded) return;
    setQuery("");
    setFiltering(false);
  }, [folded]);

  function close() {
    setQuery("");
    setFiltering(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    // The drawer closes on Escape too; this Escape only closes the filter.
    event.stopPropagation();
    close();
  }

  return (
    <Sidebar.Group aria-label="Your apps">
      <Sidebar.GroupLabel>
        {filtering ? (
          // Room for the field's ring, which the label would clip.
          <span className="block py-0.5">
            <Input
              size="sm"
              autoFocus
              aria-label="Filter your apps"
              placeholder="Filter apps"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => {
                if (query.trim() === "") close();
              }}
              // 14 px like the rows; 16 px on touch screens, so iOS does not
              // zoom into the field (Kumo's `text-base` is 14 px).
              className="h-7 w-full text-sm pointer-coarse:h-8 pointer-coarse:text-[16px]"
            />
          </span>
        ) : (
          <span className="flex min-h-7 items-center justify-between gap-2">
            <span className="truncate">Your apps</span>
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              icon={<MagnifyingGlassIcon />}
              aria-label="Filter your apps"
              title="Filter your apps"
              onClick={() => setFiltering(true)}
            />
          </span>
        )}
      </Sidebar.GroupLabel>
      <ScrollArea.Root className="relative min-w-0">
        {/* `data-sidebar="viewport"` is how Kumo's `scrollItemIntoView` finds the
            element to scroll (the nearest one around the item). It is not part of
            Kumo's documented API (read from its 2.14 sidebar source); check it
            when Kumo is upgraded. */}
        <ScrollArea.Viewport
          // Base UI makes the viewport focusable; the rows are the tab stops, as in Kumo's sidebar.
          tabIndex={-1}
          data-sidebar="viewport"
          data-capped={capped || undefined}
          className={cn(
            "min-w-0 overscroll-contain",
            // Eight rows of 34 px and the 1 px between them.
            capped && cn("max-h-[279px]", EDGE_FADE),
          )}
        >
          <ScrollArea.Content className="min-w-0!">
            <Sidebar.Menu>
              {shown.map((app) => (
                <Sidebar.MenuButton
                  key={app.id}
                  itemId={appItemId(app.id)}
                  href={`/apps/${app.id}`}
                  active={app.id === current}
                  aria-current={app.id === current ? "page" : undefined}
                  // Shown only while folded, when the name is hidden.
                  tooltip={
                    app.signal === null
                      ? app.label
                      : `${app.label}: ${APP_SIGNAL_LABELS[app.signal]}`
                  }
                  icon={<RowIcon app={app} />}
                >
                  <span data-app-label className="min-w-0 flex-1 truncate">
                    {app.label}
                  </span>
                  {app.signal !== null && (
                    // Folded, the dot on the icon stands in for this one.
                    <StatusDot
                      signal={app.signal}
                      className="group-data-[state=collapsed]/sidebar:hidden"
                    />
                  )}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
            {shown.length === 0 && (
              <Text as="p" variant="secondary" size="sm" DANGEROUS_className="px-3 py-1.5">
                No app matches “{query.trim()}”.
              </Text>
            )}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          orientation="vertical"
          className={cn(
            "flex w-1.5 touch-none select-none p-px",
            "opacity-0 transition-opacity duration-150",
            "data-[hovering]:opacity-100 data-[scrolling]:opacity-100",
            // The rail is too narrow for it; the wheel and touch still scroll.
            "group-data-[state=collapsed]/sidebar:hidden",
          )}
        >
          <ScrollArea.Thumb className="flex-1 rounded-full bg-kumo-line" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </Sidebar.Group>
  );
}

/** A row's icon; folded into the rail, it carries the app's status dot on its corner. */
function RowIcon({ app }: { app: SidebarApp }) {
  return (
    <span className="relative flex shrink-0">
      <span className="flex [&>*]:rounded-[5px]!">
        <AppIcon src={app.icon} name={app.name} size={18} />
      </span>
      {app.signal !== null && (
        <span
          aria-hidden
          data-rail-signal={app.signal}
          className={cn(
            "absolute -top-0.5 -right-0.5 flex rounded-full ring-2 ring-(--sidebar-bg)",
            "group-not-data-[state=collapsed]/sidebar:hidden",
          )}
        >
          <StatusDot signal={app.signal} className="size-1.5" />
        </span>
      )}
    </span>
  );
}
