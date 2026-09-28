import type { CaptureResult } from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGER_KEY } from "../install/memory.ts";
import {
  badgeOf,
  isReportingHost,
  linkEvents,
  type NavigationSource,
  POSTHOG_HOST,
  POSTHOG_KEY,
  posthogOptions,
  resetAnalytics,
  SEARCH_SETTLE_MS,
  startAnalytics,
  themeFromLabel,
  track,
  trackWhenSettled,
  withoutManagerReferrer,
} from "./analytics.ts";

const posthog = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: posthog }));

type Listener = Parameters<NavigationSource["subscribe"]>[1];

/** A router that only records who listens, so a test can move it. */
function fakeRouter() {
  const listeners: Listener[] = [];
  const router: NavigationSource = {
    subscribe(_event, listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
  const navigate = (pathname: string, searchStr = "") => {
    for (const listener of listeners) listener({ toLocation: { pathname, searchStr } });
  };
  return { router, navigate, listeners };
}

/** A browser at `url`, as much of one as the module reads. */
function browserAt(url: string) {
  const { hostname, host, origin, pathname, search } = new URL(url);
  vi.stubGlobal("window", {
    location: { hostname, host, origin, pathname, search },
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
}

/** The events PostHog was given, by name and URL. */
function captured(): Array<[string, unknown]> {
  return posthog.capture.mock.calls.map(([event, properties]) => [
    event,
    (properties as Record<string, unknown>).$current_url ?? properties,
  ]);
}

beforeEach(() => {
  posthog.init.mockClear();
  posthog.capture.mockClear();
});

afterEach(() => {
  resetAnalytics();
  vi.unstubAllGlobals();
});

describe("startAnalytics", () => {
  it("does nothing without a window, as while prerendering", async () => {
    expect(typeof window).toBe("undefined");
    expect(startAnalytics(fakeRouter().router)).toBe(false);
    track("category_viewed", { category: "tools" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:5173/",
    "http://127.0.0.1:4173/apps/",
    "https://appflare-docs.appflare.workers.dev/",
    "https://1a2b3c4d-appflare-docs.appflare.workers.dev/start/install/",
    "https://www.appflare.dev/",
  ])("does not report from %s", async (url) => {
    browserAt(url);
    const { router, listeners } = fakeRouter();
    track("category_viewed", { category: "tools" });
    expect(startAnalytics(router)).toBe(false);
    track("category_viewed", { category: "tools" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listeners).toHaveLength(0);
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("reports from the public address, once", async () => {
    expect(isReportingHost("appflare.dev")).toBe(true);
    browserAt("https://appflare.dev/start/install/");
    const { router, listeners } = fakeRouter();
    expect(startAnalytics(router)).toBe(true);
    expect(startAnalytics(router)).toBe(true);
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));
    const [key, options] = posthog.init.mock.calls[0] ?? [];
    expect(key).toBe(POSTHOG_KEY);
    expect(options).toMatchObject({
      api_host: POSTHOG_HOST,
      autocapture: true,
      capture_pageview: false,
      capture_pageleave: true,
      capture_dead_clicks: true,
      capture_exceptions: true,
      capture_heatmaps: true,
      disable_capture_url_hashes: true,
      persistence: "localStorage+cookie",
      person_profiles: "always",
      session_recording: { maskAllInputs: false, maskInputOptions: { password: true } },
    });
    expect(POSTHOG_HOST).toBe("https://eu.i.posthog.com");
    expect(listeners).toHaveLength(1);
  });
});

describe("page views", () => {
  it("sends one for the first page and one for each page the router moves to", async () => {
    browserAt("https://appflare.dev/start/install/");
    const { router, navigate } = fakeRouter();
    startAnalytics(router);
    navigate("/apps/", "?q=mail");
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(3));
    expect(captured()).toEqual([
      ["$pageview", "https://appflare.dev/start/install/"],
      ["$pageleave", "https://appflare.dev/start/install/"],
      ["$pageview", "https://appflare.dev/apps/?q=mail"],
    ]);
    expect(posthog.capture).toHaveBeenLastCalledWith("$pageview", {
      $current_url: "https://appflare.dev/apps/?q=mail",
      $pathname: "/apps/",
    });
  });

  it("does not count the same page again when only its search changes", async () => {
    browserAt("https://appflare.dev/apps/");
    const { router, navigate } = fakeRouter();
    startAnalytics(router);
    navigate("/apps/");
    navigate("/apps/", "?q=m");
    navigate("/apps/", "?q=ma");
    navigate("/categories/tools/");
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(3));
    expect(captured().map(([event]) => event)).toEqual(["$pageview", "$pageleave", "$pageview"]);
  });

  it("sends a page's own events that came before it started after the page view", async () => {
    browserAt("https://appflare.dev/apps/2fa/");
    track("app_page_viewed", { slug: "2fa", category: "security", categories: ["security"] });
    startAnalytics(fakeRouter().router);
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(2));
    expect(captured()).toEqual([
      ["$pageview", "https://appflare.dev/apps/2fa/"],
      ["app_page_viewed", { slug: "2fa", category: "security", categories: ["security"] }],
    ]);
  });
});

describe("linkEvents", () => {
  const here = { host: "appflare.dev", pathname: "/start/install/" };

  it("counts a link to another site by its host only", () => {
    expect(linkEvents("https://github.com/appflare/appflare/issues?q=x", here)).toEqual([
      ["outbound_click", { host: "github.com" }],
    ]);
  });

  it("counts the Deploy to Cloudflare button with the page it is on", () => {
    expect(
      linkEvents(
        "https://deploy.workers.cloudflare.com/?url=https://github.com/appflare/deploy",
        here,
      ),
    ).toEqual([
      ["outbound_click", { host: "deploy.workers.cloudflare.com" }],
      ["deploy_button_clicked", { path: "/start/install/" }],
    ]);
  });

  it("ignores links within the site and links that are not web pages", () => {
    expect(linkEvents("https://appflare.dev/apps/", here)).toEqual([]);
    expect(linkEvents("/apps/", here)).toEqual([]);
    expect(linkEvents("mailto:someone@example.com", here)).toEqual([]);
  });
});

describe("click helpers", () => {
  it("reads the theme from the switch's button label", () => {
    expect(themeFromLabel("Dark")).toBe("dark");
    expect(themeFromLabel(" System ")).toBe("system");
    expect(themeFromLabel("Toggle Theme")).toBeNull();
    expect(themeFromLabel(null)).toBeNull();
  });

  it("tells a repository badge from a catalog one", () => {
    expect(
      badgeOf("[![Install](https://appflare.dev/badge.svg)](https://appflare.dev/install/2fa/)"),
    ).toBe("app");
    expect(badgeOf("https://appflare.dev/install/?repo=owner/repo")).toBe("repo");
  });
});

describe("search events", () => {
  it("send what was searched for once the field rests", async () => {
    vi.useFakeTimers();
    try {
      browserAt("https://appflare.dev/apps/");
      startAnalytics(fakeRouter().router);
      trackWhenSettled("catalog_search", { query: "mail", query_length: 4, result_count: 2 });
      await vi.advanceTimersByTimeAsync(SEARCH_SETTLE_MS);
      expect(posthog.capture).toHaveBeenCalledWith("catalog_search", {
        query: "mail",
        query_length: 4,
        result_count: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the referrer guard", () => {
  const manager = "https://appflare.example.com";

  function event(referrer: string): CaptureResult {
    return {
      uuid: "0",
      event: "$pageview",
      properties: { $referrer: referrer, $referring_domain: new URL(referrer).host },
      $set_once: {
        $initial_referrer: referrer,
        $initial_referring_domain: new URL(referrer).host,
      },
    };
  }

  it("drops a referrer from the visitor's own Appflare", () => {
    const sent = withoutManagerReferrer(event(`${manager}/settings/account`), manager);
    expect(sent?.properties).toMatchObject({ $referrer: "$direct", $referring_domain: "$direct" });
    expect(sent?.$set_once).toEqual({
      $initial_referrer: "$direct",
      $initial_referring_domain: "$direct",
    });
    expect(JSON.stringify(sent)).not.toContain("example.com");
  });

  it("keeps every other referrer", () => {
    const github = "https://github.com/owner/repo";
    expect(withoutManagerReferrer(event(github), manager)?.properties.$referrer).toBe(github);
    expect(withoutManagerReferrer(event(github), null)?.properties.$referrer).toBe(github);
    // The same host on another scheme is another origin.
    const other = "http://appflare.example.com/";
    expect(withoutManagerReferrer(event(other), manager)?.properties.$referrer).toBe(other);
    expect(withoutManagerReferrer(null, manager)).toBeNull();
  });

  it("reads the Appflare that /my/ remembers", () => {
    const stored = new Map([[MANAGER_KEY, manager]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
    const beforeSend = posthogOptions.before_send;
    if (typeof beforeSend !== "function") throw new Error("before_send is not a function");
    expect(beforeSend(event(`${manager}/`))?.properties.$referrer).toBe("$direct");
    stored.clear();
    expect(beforeSend(event(`${manager}/`))?.properties.$referrer).toBe(`${manager}/`);
  });
});
