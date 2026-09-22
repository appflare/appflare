import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/**
 * TanStack Start instance options.
 *
 * `defaultSsr: false`: no route renders or loads on the server; the manager is an
 * SPA. SPA mode alone relies on the build-time shell prerender
 * seeing `process.env.TSS_PRERENDERING`, which is set in Node and is not visible
 * inside workerd, where the Cloudflare plugin runs the prerender. Without this
 * the "shell" would be a full render of `/` that follows the auth redirects and
 * bakes the `/setup` page into index.html. With it, the server only ever renders
 * the document shell plus the pending fallback.
 *
 * CSRF: defining this file replaces Start's default server-function CSRF
 * middleware, so it is installed explicitly. It accepts only requests proven
 * same-origin by `Sec-Fetch-Site`, `Origin`, or `Referer`. Better Auth's
 * `/api/auth/*` routes do their own origin check against `trustedOrigins`.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  defaultSsr: false,
  requestMiddleware: [csrfMiddleware],
}));
