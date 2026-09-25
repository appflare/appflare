/**
 * Which route answers an address no route matches: always the root route,
 * whatever part of the address matches (`/apps/<id>/foo`, `/catalog/a/b`).
 * In TanStack Router's default ("fuzzy") mode the deepest matching layout
 * answers instead, rendering the not-found view in its outlet; for those
 * addresses that is the signed-in layout, which in the browser rendered
 * without its loader data and threw. At the root nothing below it runs its
 * `beforeLoad` or loader, or renders.
 *
 * Its own module so tests can use it without the route tree, which only
 * builds under TanStack Start's Vite plugin.
 */
export const NOT_FOUND_MODE = "root" as const;
