/**
 * The `Content-Type` an uploaded static asset is served with. wrangler 4.136.2
 * (`getContentType` in its assets upload) uses the `mime` package and appends
 * `; charset=utf-8` to `text/*`; an unknown extension is sent as
 * `application/null`, which Cloudflare reads as "send no Content-Type". This map
 * covers the extensions web apps ship; anything else falls back the same way.
 */
const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/vnd.microsoft.icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};

export const NO_CONTENT_TYPE = "application/null";

export function assetContentType(route: string): string {
  const base = route.slice(route.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const type = dot === -1 ? undefined : TYPES[base.slice(dot + 1).toLowerCase()];
  if (type === undefined) return NO_CONTENT_TYPE;
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}
