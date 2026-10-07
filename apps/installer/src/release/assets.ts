import {
  ARTIFACT_FETCH_SUBREQUESTS,
  type AssetFile,
  byOffset,
  SpanBuilder,
} from "@appflare/schema";

/**
 * Splitting the static files Cloudflare asks for into parts that each fit
 * one request, and the content type each is served with. The same plan the
 * manager's asset upload makes (apps/manager/src/jobs/install/asset-parts.ts
 * and mime.ts).
 */

/** Subrequests one asset part may make, leaving room for the upload session and the record. */
export const ASSET_PART_SUBREQUESTS = 34;

/** Bytes one part downloads at most, gaps included (bytes, base64 copy and body are held at once). */
export const ASSET_PART_BYTES = 16 * 1024 * 1024;

export interface AssetPart {
  files: AssetFile[];
  ranges: number;
  bytes: number;
  subrequests: number;
}

/**
 * Worst-case subrequests of a part: the first range may be redirected, the
 * rest go to the resolved URL; then one bulk upload, or one per file when the
 * session asks for single-file uploads.
 */
export function assetPartCost(ranges: number, files: number, single: boolean): number {
  const fetches = ranges === 0 ? 0 : ARTIFACT_FETCH_SUBREQUESTS + ranges - 1;
  return fetches + (single ? files : 1);
}

export function planAssetParts(
  files: readonly AssetFile[],
  single: boolean,
  limits = { subrequests: ASSET_PART_SUBREQUESTS, bytes: ASSET_PART_BYTES },
): AssetPart[] {
  const parts: AssetPart[] = [];
  let spans = new SpanBuilder<AssetFile>();
  let current: AssetFile[] = [];
  const close = () => {
    if (current.length === 0) return;
    parts.push({
      files: current,
      ranges: spans.spans.length,
      bytes: spans.bytes,
      subrequests: assetPartCost(spans.spans.length, current.length, single),
    });
    spans = new SpanBuilder<AssetFile>();
    current = [];
  };
  for (const file of byOffset(files)) {
    const { newSpan, addedBytes } = spans.preview(file);
    const cost = assetPartCost(spans.spans.length + (newSpan ? 1 : 0), current.length + 1, single);
    if (
      current.length > 0 &&
      (cost > limits.subrequests || spans.bytes + addedBytes > limits.bytes)
    ) {
      close();
    }
    spans.add(file);
    current.push(file);
  }
  close();
  return parts;
}

/** The claims of a JWT, unverified: only to read what the upload session asks for. */
export function jwtClaims(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split(".")[1];
    if (part === undefined) return {};
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const text = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

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

/**
 * The `Content-Type` an asset is uploaded with, as wrangler 4.136.2 picks it
 * (`text/*` gets `; charset=utf-8`); an unknown extension is sent as
 * `application/null`, which Cloudflare reads as "send no Content-Type".
 */
export function assetContentType(route: string): string {
  const base = route.slice(route.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const type = dot === -1 ? undefined : TYPES[base.slice(dot + 1).toLowerCase()];
  if (type === undefined) return "application/null";
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}

/** Standard base64 of `bytes` (what the bulk asset upload sends). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
