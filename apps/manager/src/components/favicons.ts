/**
 * The favicon set in `public/`, as the head tags every page carries: the app
 * shell and the static Access-denied page (client-safe).
 *
 * The files are static assets, served before the Worker runs, so they load on
 * the sign-in and setup pages without a session. The SVG switches to a white
 * mark in a dark browser theme; the PNG and the ICO are for browsers without
 * SVG favicons; iOS uses the touch icon and the title for a home-screen icon.
 */

export const FAVICON_LINKS = [
  { rel: "icon", type: "image/png", href: "/favicon-96x96.png", sizes: "96x96" },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "shortcut icon", href: "/favicon.ico" },
  { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
] as const;

export const FAVICON_META = [{ name: "apple-mobile-web-app-title", content: "Appflare" }] as const;
