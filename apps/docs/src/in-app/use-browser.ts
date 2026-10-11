import { useSyncExternalStore } from "react";
import { type BrowserKind, detectBrowser } from "./browser.ts";

/**
 * The browser this page runs in, for components. Null while the page is
 * prerendered and while it hydrates (the built HTML is the same for every
 * browser), then the browser's kind.
 */
export function useBrowser(): BrowserKind | null {
  return useSyncExternalStore(subscribe, currentBrowser, serverBrowser);
}

/** The user agent does not change while the page is open. */
const subscribe = () => () => {};
const serverBrowser = () => null;

let cached: { userAgent: string; standalone: boolean; kind: BrowserKind } | null = null;

/** This browser's kind; the same object while the user agent stays the same. */
export function currentBrowser(): BrowserKind | null {
  if (typeof navigator === "undefined") return null;
  const userAgent = navigator.userAgent;
  // Safari on iOS only: true in a web app opened from the Home Screen.
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (cached?.userAgent !== userAgent || cached.standalone !== standalone) {
    cached = { userAgent, standalone, kind: detectBrowser(userAgent, { standalone }) };
  }
  return cached.kind;
}
