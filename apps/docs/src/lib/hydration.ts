/** The part of the router {@link settled} needs. */
export interface SettlingRouter {
  readonly state: { readonly matches: ReadonlyArray<{ readonly status: string }> };
  load(options: { sync: true }): Promise<void>;
}

/**
 * `router`, once the page it is about to hydrate has finished loading.
 *
 * Every page is prerendered, so the router usually starts with everything it
 * shows already loaded. Not on an address the site does not have: one page,
 * `404.html`, answers all of them, and it was rendered for `/404`. Hydrating
 * it at the visitor's own address, the router matches that address's route
 * and shows it as loading, which renders nothing, until its loader settles;
 * an app's or a category's loader first downloads the catalog. Hydrating
 * meanwhile, React finds the not-found page's markup where it renders
 * nothing, and throws (minified React error 418). Once the loader has
 * settled, the router shows the not-found page, the same markup as
 * `404.html`.
 */
export async function settled<R extends SettlingRouter>(
  router: R,
  waitMs = SETTLE_WAIT_MS,
): Promise<R> {
  if (!router.state.matches.some((match) => match.status === "pending")) return router;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    // As the router's first load would: a failure shows the route's error, not a blank page.
    router.load({ sync: true }).catch(console.error),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return router;
}

/**
 * How long hydrating waits for that load. A catalog that never arrives must
 * not leave the page dead: past this, the page hydrates anyway, React throws
 * error 418 and renders it afresh, and the links and search work again.
 */
export const SETTLE_WAIT_MS = 3000;
