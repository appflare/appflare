/** Install links count clicks at the shortener before opening either installer. */
export const HOSTED_INSTALL_URL = "https://link.appflare.dev/deploy";
export const CLOUDFLARE_DEPLOY_URL = "https://link.appflare.dev/deploy-1c";

export function installLink(
  placement: string,
  legacy = false,
  attribution = { source: "appflare-docs", medium: "website" },
): string {
  return attributedLink(
    legacy ? CLOUDFLARE_DEPLOY_URL : HOSTED_INSTALL_URL,
    placement,
    attribution,
  );
}

export function attributedLink(
  href: string,
  placement: string,
  attribution = { source: "appflare-docs", medium: "website" },
): string {
  const url = new URL(href);
  url.searchParams.set("utm_source", attribution.source);
  url.searchParams.set("utm_medium", attribution.medium);
  url.searchParams.set("utm_campaign", "appflare");
  url.searchParams.set("utm_content", placement);
  return url.href;
}
