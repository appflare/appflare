import { Button, cn, Input, Sidebar, Text, useSidebar } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
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
 * The sidebar's "Your apps": every install by name, each row with the app's
 * icon, what it is called here, and the dot of its most severe "Needs
 * attention" row; a row opens the app's page. At most eight rows show and
 * the rest scroll inside the group, which keeps the open app's row in view.
 * The search icon beside the heading turns it into a filter field (Escape
 * clears and closes it). The app shell leaves the group out while nothing is
 * installed and while the sidebar is folded into its rail.
 */
export function SidebarAppsGroup({
  apps,
  pathname,
}: {
  /** Sorted by name (`sidebarApps`). */
  apps: readonly SidebarApp[];
  pathname: string;
}) {
  const { scrollItemIntoView } = useSidebar();
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState("");
  const shown = filterApps(apps, query);
  const current = currentAppId(pathname);

  // Kumo scrolls the nearest `data-sidebar="viewport"`: the group's own list.
  useEffect(() => {
    if (current !== null) scrollItemIntoView(appItemId(current), { align: "center" });
  }, [current, scrollItemIntoView]);

  // While more rows are below, the list's bottom edge fades out.
  const list = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = useCallback(() => {
    const el = list.current;
    setMoreBelow(el !== null && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rows shown change the list's height.
  useEffect(measure, [measure, shown.length, current]);

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
      {/* `data-sidebar="viewport"` is how Kumo's `scrollItemIntoView` finds the
          element to scroll (the nearest one around the item). It is not part of
          Kumo's documented API (read from its 2.14 sidebar source); check it
          when Kumo is upgraded. */}
      <div
        ref={list}
        onScroll={measure}
        data-sidebar="viewport"
        data-capped={apps.length > MAX_VISIBLE_APPS || undefined}
        className={cn(
          "min-w-0 overflow-y-auto overflow-x-hidden",
          // Eight rows of 34 px and the 1 px between them.
          apps.length > MAX_VISIBLE_APPS && "max-h-[279px]",
          moreBelow &&
            "[mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent_100%)]",
        )}
      >
        <Sidebar.Menu>
          {shown.map((app) => (
            <Sidebar.MenuButton
              key={app.id}
              itemId={appItemId(app.id)}
              href={`/apps/${app.id}`}
              active={app.id === current}
              aria-current={app.id === current ? "page" : undefined}
              icon={
                <span className="flex shrink-0 [&>*]:rounded-[5px]!">
                  <AppIcon src={app.icon} name={app.name} size={18} />
                </span>
              }
            >
              <span data-app-label className="min-w-0 flex-1 truncate">
                {app.label}
              </span>
              {app.signal !== null && <StatusDot signal={app.signal} />}
            </Sidebar.MenuButton>
          ))}
        </Sidebar.Menu>
        {shown.length === 0 && (
          <Text as="p" variant="secondary" size="sm" DANGEROUS_className="px-3 py-1.5">
            No app matches “{query.trim()}”.
          </Text>
        )}
      </div>
    </Sidebar.Group>
  );
}
