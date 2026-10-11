/**
 * What kind of browser a visitor is in, read from its user agent: an app's
 * own browser (the one X, Instagram or LinkedIn open links in), a phone's
 * browser, or anything else (a computer, a tablet).
 *
 * An app's own browser often cannot finish installing Appflare: Google
 * refuses to sign in inside one, so a Cloudflare login through Google stops
 * there, and what the page keeps for the sign-in (this tab's storage) stays
 * behind when the visitor moves to their real browser halfway. The install
 * buttons offer to open the page in a real browser first, and to go on
 * anyway (see the components in `components/in-app/`): email and password
 * can work there, and a browser can be taken for an app's by mistake.
 *
 * Pure and dependency-free; `use-browser.ts` reads the browser's own values.
 */

export type Platform = "ios" | "android" | "other";

export type BrowserKind =
  /** An app's own browser. `app` names the app when its user agent says which. */
  | { kind: "in-app"; app: string | null; platform: Platform }
  /** A phone's own browser (Safari, Chrome, Firefox…). */
  | { kind: "phone"; platform: Platform }
  /** A computer, a tablet, or anything not recognised. */
  | { kind: "other"; platform: Platform };

/**
 * The apps whose browsers say who they are, by the mark each puts in the
 * user agent, after PostHog's own list (`$webview_app`). Order matters where
 * one app's agent carries another's mark: Threads and Messenger before
 * Instagram and Facebook. Google's and Bing's search apps are left out:
 * signing in works there.
 */
const MARKED_APPS: ReadonlyArray<readonly [app: string, mark: RegExp]> = [
  ["X", /\bTwitter(?:Android| for (?:iPhone|iPad|Android))\b/i],
  ["Threads", /\bBarcelona[ /]\d/i],
  ["Instagram", /\bInstagram\b/i],
  ["Messenger", /\b(?:MessengerForiOS|(?:FBAN|FB_IAB)\/Orca-Android)\b/i],
  ["Facebook", /\b(?:FBAN|FBAV|FBIOS|FB_IAB|FB4A)\b/i],
  ["LinkedIn", /\bLinkedInApp\b/i],
  // TikTok writes its version straight after the mark: `musical_ly_32.5.3`.
  ["TikTok", /\b(?:musical_ly|trill|BytedanceWebview)(?=\b|_)/i],
  ["Snapchat", /\bSnapchat\b/i],
  ["Pinterest", /\bPinterest\b/i],
  ["Line", /\bLine\/\d/],
  ["WeChat", /\bMicroMessenger\//i],
  ["WhatsApp", /\b(?:WA4A|WAiOS)\//i],
  ["KakaoTalk", /\bKAKAOTALK\b/i],
  ["Naver", /\bNAVER\(inapp;/i],
];

export function platformOf(userAgent: string): Platform {
  if (/\b(?:iPhone|iPod|iPad)\b/.test(userAgent)) return "ios";
  if (/\bAndroid\b/.test(userAgent)) return "android";
  return "other";
}

/** A phone rather than a tablet: an iPhone, or Android's "Mobile" mark. */
function isPhone(userAgent: string, platform: Platform): boolean {
  if (platform === "ios") return /\b(?:iPhone|iPod)\b/.test(userAgent);
  if (platform === "android") return /\bMobile\b/.test(userAgent);
  return false;
}

/**
 * An app's browser that does not name its app. On Android the system
 * WebView marks itself `; wv)`. On iOS an app's WebKit view leaves out the
 * `Safari/` mark that Safari and every other iOS browser (Chrome, Firefox,
 * Edge) carry; a web app opened from the Home Screen leaves it out too,
 * which `standalone` tells apart.
 */
function isUnnamedWebView(userAgent: string, platform: Platform, standalone: boolean): boolean {
  if (platform === "android") return /; wv\)/.test(userAgent);
  if (platform === "ios") {
    return /\bAppleWebKit\//.test(userAgent) && !/\bSafari\//.test(userAgent) && !standalone;
  }
  return false;
}

/**
 * The browser a user agent describes. `standalone` is iOS Safari's
 * `navigator.standalone` (a web app opened from the Home Screen).
 */
export function detectBrowser(
  userAgent: string,
  options: { standalone?: boolean } = {},
): BrowserKind {
  const platform = platformOf(userAgent);
  for (const [app, mark] of MARKED_APPS) {
    if (mark.test(userAgent)) return { kind: "in-app", app, platform };
  }
  if (isUnnamedWebView(userAgent, platform, options.standalone === true)) {
    return { kind: "in-app", app: null, platform };
  }
  return isPhone(userAgent, platform) ? { kind: "phone", platform } : { kind: "other", platform };
}

/** How the page names the browser: "X's in-app browser", or "This in-app browser". */
export function inAppBrowserName(app: string | null): string {
  return app === null ? "This in-app browser" : `${app}'s in-app browser`;
}

/** Chrome on Android, which an app's browser hands an `intent:` link to. */
export const CHROME_PACKAGE = "com.android.chrome";

/**
 * A link that opens `url` in Chrome from an app's browser on Android. Where
 * Chrome is missing, Android opens `url` itself (`browser_fallback_url`),
 * which lands back on the same page. Null for anything but an https address.
 */
export function chromeIntentUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const fallback = encodeURIComponent(parsed.href);
  return `intent://${parsed.host}${parsed.pathname}${parsed.search}#Intent;scheme=https;package=${CHROME_PACKAGE};S.browser_fallback_url=${fallback};end`;
}
