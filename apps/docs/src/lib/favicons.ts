/**
 * The favicon set in `public/`, as the head tags every page carries. The SVG
 * switches to a white mark in a dark browser theme; the PNG and the ICO are
 * for browsers without SVG favicons; iOS uses the touch icon and the title for
 * a home-screen icon.
 */

export const faviconLinks = [
  { rel: "icon", type: "image/png", href: "/favicon-96x96.png", sizes: "96x96" },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "shortcut icon", href: "/favicon.ico" },
  { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
] as const;

export const faviconMeta = [
  { name: "apple-mobile-web-app-title", content: "Appflare docs" },
] as const;
