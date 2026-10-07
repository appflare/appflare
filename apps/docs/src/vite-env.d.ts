/** Build-time variables the site reads (Vite exposes those that start with `VITE_`). */
interface ImportMetaEnv {
  /** Another Cloudflare OAuth client for the deploy page, for development. */
  readonly VITE_APPFLARE_OAUTH_CLIENT_ID?: string;
  /** That client's callback, on the origin the page is served from. */
  readonly VITE_APPFLARE_OAUTH_CALLBACK_URL?: string;
}
