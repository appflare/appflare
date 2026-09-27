import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { arriveAtHash, type HashTargetWindow } from "./hash-target";

/** The browser behind {@link arriveAtHash}. */
export function browserHashTargetWindow(): HashTargetWindow {
  return {
    getElementById: (id) => document.getElementById(id),
    prefersReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
    now: () => Date.now(),
  };
}

/** What {@link followHashTargets} needs of the router: its resolved navigations. */
export interface HashTargetRouter {
  subscribe(
    event: "onResolved",
    listener: (event: { hrefChanged: boolean; toLocation: { hash: string } }) => void,
  ): () => void;
}

/** What {@link followHashTargets} needs of the page: its hash and `hashchange`. */
export interface HashTargetLocation {
  readonly hash: string;
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/**
 * Arrives at the hash the page opened with, then at the hash of every
 * navigation to a new address (a link to another section of the same page
 * included) and every `hashchange`. Reloading the page's data after an
 * action resolves too but keeps the address, so it does not scroll back.
 * Returns the cleanup.
 */
export function followHashTargets(
  win: HashTargetWindow,
  router: HashTargetRouter,
  location: HashTargetLocation,
): () => void {
  let cleanup = arriveAtHash(win, location.hash);
  function arrive(hash: string) {
    cleanup();
    cleanup = arriveAtHash(win, hash);
  }
  const unsubscribe = router.subscribe("onResolved", (event) => {
    if (event.hrefChanged) arrive(event.toLocation.hash);
  });
  const onHashChange = () => arrive(location.hash);
  location.addEventListener("hashchange", onHashChange);
  return () => {
    unsubscribe();
    location.removeEventListener("hashchange", onHashChange);
    cleanup();
  };
}

/**
 * Scrolls to and rings the element the location hash names, on the first
 * page load and after every navigation that ends on a hash. Used once, by
 * the app shell.
 */
export function useHashTarget(): void {
  const router = useRouter();
  useEffect(
    () =>
      followHashTargets(browserHashTargetWindow(), router, {
        get hash() {
          return window.location.hash;
        },
        addEventListener: (type, listener) => window.addEventListener(type, listener),
        removeEventListener: (type, listener) => window.removeEventListener(type, listener),
      }),
    [router],
  );
}
