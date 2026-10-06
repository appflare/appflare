import type { CaptureResult, PostHog, PostHogConfig } from "posthog-js";
import { openedAt } from "../deploy/arrival.ts";
import { isDeployPath } from "../deploy/paths.ts";
import { browserMemory } from "../install/memory.ts";
import { SITE_URL } from "../lib/shared.ts";

/**
 * Analytics for this site, in PostHog: page views, clicks, session
 * recordings, heatmaps, web vitals and errors, plus the site's own events
 * ({@link SiteEvents}). The site is the project's own and has no accounts,
 * so nothing asks first; the privacy page says what is collected.
 *
 * It runs only in a browser on the public address. The page is prerendered
 * without it, and a local server or a preview on another address sends
 * nothing, so development never reaches the reports. The library itself is
 * loaded after the page, so it never delays the first paint.
 *
 * The address of a visitor's Appflare is theirs, not the site's: it is never
 * an event property, and the elements that show it carry
 * {@link PRIVATE_CLASS}, which keeps them out of recordings, autocapture and
 * {@link SiteEvents.outbound_click}. URL fragments (where `/my/` receives
 * that address) are stripped from everything sent.
 *
 * The deploy page and its OAuth callback (`/deploy/…`) are never measured:
 * PostHog is not even loaded in a page opened there (no page views,
 * recordings, heatmaps or clicks), the router reloads the page when it moves
 * to one from elsewhere (see the deploy routes), and anything still sent
 * from such a path is dropped before it leaves.
 */

/** The PostHog project's key. It is public by design: every page that reports carries it. */
export const POSTHOG_KEY = "phc_vvhuhY8yQFBuE5pGUe7rmrasqxaHb3MibmUNyQdSK8qW";

/** PostHog's EU region. Its scripts load from the matching asset host, eu-assets.i.posthog.com. */
export const POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * The class that keeps an element out of recordings (drawn as an empty box),
 * autocapture, dead clicks and this module's own click events. PostHog's
 * default for all of them, so one class covers every path.
 */
export const PRIVATE_CLASS = "ph-no-capture";

/** The page that shows the Install badge's snippets. */
export const BADGE_PAGE = "/catalog/install-badge/";

/** How long a search field has to rest before its search is counted, so typing is one search. */
export const SEARCH_SETTLE_MS = 1000;

/** Whether pages served at `hostname` report: only the public address, never localhost or a preview. */
export function isReportingHost(hostname: string): boolean {
  return hostname === new URL(SITE_URL).hostname;
}

/** The events this site sends besides PostHog's own, with their properties. */
export interface SiteEvents {
  /** A visitor arrived on an install page (from an Install button or badge) and it picked its first step. */
  install_link_clicked: {
    kind: "app" | "repo";
    /** The catalog slug, for an app. */
    slug: string | null;
    /** `owner/repo`, for a GitHub repository (a public name). */
    repo: string | null;
    /** Whether this browser remembered the visitor's Appflare. */
    has_manager: boolean;
    /** `manager`: the page sends them to their Appflare; `no-manager`: it asks or offers the catalog's app. */
    target: "manager" | "no-manager";
  };
  /** A Deploy to Cloudflare button (or link) was clicked. */
  deploy_button_clicked: { path: string };
  /** A visitor told the site where their Appflare is. The address itself is never sent. */
  manager_registered: { has_manager: true; page: "my" | "install" };
  /** A prompt for a coding agent was copied, on the page it was copied from. */
  agent_prompt_copied: { page: string };
  /** A snippet on the Install badge page was copied. */
  badge_form_used: { badge: "app" | "repo"; via: "copy-button" | "selection" };
  /** A search on the apps page, once the field rests: what was searched for and what it found. */
  catalog_search: { query: string; query_length: number; result_count: number };
  app_page_viewed: { slug: string; category: string | null; categories: string[] };
  category_viewed: { category: string };
  /** A link to another site was clicked. */
  outbound_click: { host: string };
  theme_toggled: { theme: "light" | "dark" | "system" };
  /** A search in the documentation's search dialog, once the field rests: what was searched for and how many pages it found. */
  docs_search: { query: string; query_length: number; result_count: number };
}

export type SiteEvent = keyof SiteEvents;

/** How PostHog is set up here. Exported for the tests. */
export const posthogOptions: Partial<PostHogConfig> = {
  api_host: POSTHOG_HOST,
  defaults: "2026-08-30",
  autocapture: true,
  // Page views come from the router (see `watchPageviews`), one per page.
  capture_pageview: false,
  capture_pageleave: true,
  capture_performance: { web_vitals: true, network_timing: true },
  capture_heatmaps: true,
  capture_dead_clicks: true,
  capture_exceptions: true,
  disable_session_recording: false,
  session_recording: {
    // Nothing on the site is personal but the Appflare address, which is blocked by class.
    maskAllInputs: false,
    maskInputOptions: { password: true },
    maskTextSelector: null,
    blockClass: PRIVATE_CLASS,
  },
  // `/my/` receives the visitor's Appflare address in the fragment.
  disable_capture_url_hashes: true,
  before_send: (event) =>
    withoutManagerReferrer(
      outsideDeployPages(
        event,
        typeof window === "undefined" ? null : (window.location?.href ?? null),
      ),
      browserMemory().manager(),
    ),
  persistence: "localStorage+cookie",
  person_profiles: "always",
  respect_dnt: false,
};

/** What PostHog records for a visit that came from no page. */
const DIRECT = "$direct";

/** The origin of `url`, or null when it is not an address. */
function originOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * `event` with its referrer dropped when the visitor came from their own
 * Appflare (`manager`, the origin `/my/` remembers): that address is theirs.
 * Appflare links here without a referrer; this holds even for a link that
 * forgets to. The first referrer PostHog keeps on the person goes the same way.
 */
export function withoutManagerReferrer(
  event: CaptureResult | null,
  manager: string | null,
): CaptureResult | null {
  if (event === null || manager === null) return event;
  const fromManager = (url: unknown) => originOf(url) === manager;
  if (fromManager(event.properties.$referrer)) {
    event.properties.$referrer = DIRECT;
    event.properties.$referring_domain = DIRECT;
  }
  const once = event.$set_once;
  if (once !== undefined && fromManager(once.$initial_referrer)) {
    once.$initial_referrer = DIRECT;
    once.$initial_referring_domain = DIRECT;
  }
  return event;
}

/** The path of `url`, or null when it is not an address. */
function pathOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * `event`, or null when it comes from the deploy page or its callback: the
 * page the browser is on now (`here`) or the one the event names.
 */
export function outsideDeployPages(
  event: CaptureResult | null,
  here: string | null,
): CaptureResult | null {
  if (event === null) return null;
  const paths = [pathOf(here), pathOf(event.properties.$current_url), event.properties.$pathname];
  return paths.some((path) => typeof path === "string" && isDeployPath(path)) ? null : event;
}

/** The part of the router this needs. */
export interface NavigationSource {
  subscribe(
    event: "onResolved",
    listener: (event: { toLocation: { pathname: string; searchStr: string } }) => void,
  ): () => void;
}

let client: Promise<PostHog> | null = null;
let stop: (() => void) | null = null;

/**
 * Events sent before reporting starts. A page's own effects run before the
 * root's, so the events of the page a visitor arrives on come in first and
 * wait here for the page view.
 */
const pending: Array<[string, Record<string, unknown>]> = [];
/** Set when this page does not report, so nothing more waits. */
let closed = false;
const MAX_PENDING = 20;

/**
 * Starts reporting, once, when this runs in a browser on the public address:
 * loads PostHog, sends the first page view, one more for each page the
 * router moves to, and the click events. Returns whether it started.
 */
export function startAnalytics(router: NavigationSource): boolean {
  if (typeof window === "undefined") return false;
  if (client !== null) return true;
  const early = pending.splice(0);
  const deployPage = isDeployPath(window.location.pathname) || isDeployPath(openedAt ?? "");
  if (!isReportingHost(window.location.hostname) || deployPage) {
    closed = true;
    return false;
  }
  client = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(POSTHOG_KEY, posthogOptions);
    return posthog;
  });
  const unwatch = watchPageviews(router);
  for (const [event, properties] of early) capture(event, properties);
  const unlisten = listenToClicks(window.document);
  stop = () => {
    unwatch();
    unlisten();
  };
  return true;
}

/** Sends one of the site's events. Before reporting starts it waits; on a page that does not report it is dropped. */
export function track<E extends SiteEvent>(event: E, properties: SiteEvents[E]): void {
  capture(event, { ...properties });
}

/**
 * Sends `event` once the field it describes has rested for
 * {@link SEARCH_SETTLE_MS}. Returns the cancel, for an effect's cleanup.
 */
export function trackWhenSettled<E extends SiteEvent>(
  event: E,
  properties: SiteEvents[E],
): () => void {
  if (closed) return () => {};
  const timer = setTimeout(() => track(event, properties), SEARCH_SETTLE_MS);
  return () => clearTimeout(timer);
}

/** Forgets that reporting started. For tests only. */
export function resetAnalytics(): void {
  stop?.();
  stop = null;
  client = null;
  closed = false;
  pending.length = 0;
  lastPath = null;
  lastUrl = null;
}

function capture(event: string, properties: Record<string, unknown>): void {
  if (client === null) {
    if (!closed && typeof window !== "undefined" && pending.length < MAX_PENDING) {
      pending.push([event, properties]);
    }
    return;
  }
  void client.then((posthog) => {
    posthog.capture(event, properties);
  });
}

let lastPath: string | null = null;
let lastUrl: string | null = null;

/** A page view for `pathname` + `search`, closing the page before it. */
function pageview(pathname: string, search: string): void {
  // The apps page writes its search field into the address as it is typed:
  // that is one page, with its own `catalog_search` event.
  if (pathname === lastPath) return;
  // The deploy routes reload the page instead of rendering here; nothing of them is sent.
  if (isDeployPath(pathname)) return;
  const url = `${window.location.origin}${pathname}${search}`;
  if (lastUrl !== null) capture("$pageleave", { $current_url: lastUrl });
  capture("$pageview", { $current_url: url, $pathname: pathname });
  lastPath = pathname;
  lastUrl = url;
}

/** The page the visitor arrived on, then one page view per page the router moves to. */
function watchPageviews(router: NavigationSource): () => void {
  pageview(window.location.pathname, window.location.search);
  return router.subscribe("onResolved", ({ toLocation }) => {
    pageview(toLocation.pathname, toLocation.searchStr);
  });
}

/** Where a visitor is, for {@link linkEvents}. */
export interface Here {
  host: string;
  pathname: string;
}

type EventCall = { [E in SiteEvent]: [E, SiteEvents[E]] }[SiteEvent];

/** The events a click on a link to `href` sends from `here`. */
export function linkEvents(href: string, here: Here): EventCall[] {
  let url: URL;
  try {
    url = new URL(href, `https://${here.host}`);
  } catch {
    return [];
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return [];
  if (url.host === here.host) return [];
  const events: EventCall[] = [["outbound_click", { host: url.host }]];
  if (url.host === "deploy.workers.cloudflare.com" || isDeployLink(url)) {
    events.push(["deploy_button_clicked", { path: here.pathname }]);
  }
  return events;
}

/** Appflare's own short link to the Deploy to Cloudflare button, which counts its clicks. */
function isDeployLink(url: URL): boolean {
  return url.host === "link.appflare.dev" && url.pathname.replace(/\/$/, "") === "/deploy";
}

const THEMES = new Set(["light", "dark", "system"] as const);

/** The theme a click on the theme switch chose, from the button's label. */
export function themeFromLabel(label: string | null): SiteEvents["theme_toggled"]["theme"] | null {
  const theme = label?.trim().toLowerCase();
  for (const known of THEMES) if (known === theme) return known;
  return null;
}

/** Which badge a snippet is for. */
export function badgeOf(snippet: string): SiteEvents["badge_form_used"]["badge"] {
  return snippet.includes("?repo=") ? "repo" : "app";
}

function isPrivate(element: Element): boolean {
  return element.closest(`.${PRIVATE_CLASS}`) !== null;
}

/** Links, the theme switch and the badge snippets, heard once for the whole document. */
function listenToClicks(document: Document): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || isPrivate(target)) return;
    const here = { host: window.location.host, pathname: window.location.pathname };

    const link = target.closest("a[href]");
    if (link instanceof HTMLAnchorElement) {
      for (const [name, properties] of linkEvents(link.href, here)) capture(name, properties);
      return;
    }

    const themeButton = target.closest("[data-theme-toggle] button");
    if (themeButton !== null) {
      const theme = themeFromLabel(themeButton.getAttribute("aria-label"));
      if (theme !== null) track("theme_toggled", { theme });
      return;
    }

    const copyButton = target.closest("figure button");
    if (copyButton !== null && here.pathname === BADGE_PAGE) {
      const snippet = copyButton.closest("figure")?.textContent ?? "";
      track("badge_form_used", { badge: badgeOf(snippet), via: "copy-button" });
    }
  };

  const onCopy = () => {
    if (window.location.pathname !== BADGE_PAGE) return;
    const selection = document.getSelection();
    const figure = selection?.anchorNode?.parentElement?.closest("figure");
    if (!figure) return;
    track("badge_form_used", { badge: badgeOf(selection?.toString() ?? ""), via: "selection" });
  };

  document.addEventListener("click", onClick, { capture: true });
  document.addEventListener("copy", onCopy);
  return () => {
    document.removeEventListener("click", onClick, { capture: true });
    document.removeEventListener("copy", onCopy);
  };
}
