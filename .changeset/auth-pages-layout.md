---
"@appflare/manager": patch
---

The sign-in and setup pages share one layout: the full logo above a single centred card with a clear title and subtitle, full-width actions with loading states, a password field with a show/hide button and the right autocomplete hints for password managers, a proper "or" divider before the full-width passkey button, and a footer with Appflare's version linking to the documentation. Setup shows which of its three steps you are on (create the admin account, sign in, connect Cloudflare). Sign-in and setup errors are shown as plain sentences instead of the server's own text. The page shown when Cloudflare Access refuses a request uses the same layout, with the recovery steps for a locked-out admin.

The whole manager now follows the browser's light or dark preference.

When Cloudflare Access refuses one of the app's own requests, the page now says so ("Cloudflare Access refused this request. Sign in through Access and try again.") with a Reload button, instead of "Something went wrong". Refusals answered as JSON carry `code: "access_denied"`.

The sidebar footer shows Appflare's version on the left and the account menu on the right, and the Update and Try again buttons in the sidebar's update card sit on the left.
