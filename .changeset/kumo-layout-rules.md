---
"@appflare/manager": patch
---

Pages follow Kumo's layout rules more closely: an app's page, a job's page and a build's review page are made of sections with a real heading and one card each, and nothing sits outside a card or inside a second one. Pages have a soft background so their cards stand out, in light and dark mode. The banner's Update button on an app's page is secondary, leaving Open as the page's one main action. Resetting a user's password offers only a recovery code once reset emails are off, even if they were turned off on the same page. Dialogs opened from "From a repository", "Rebuild and update" and a user's menu animate in and out, and closing them puts focus back where it was. A catalog tile's plan can be reached with the keyboard to read what it means. Fenced code in an app's next steps shows as a code block. Notification channels use Phosphor's Telegram, Slack and Discord logos.

Technical detail is shown on request instead of by default: an app's page no longer names its Worker under the title; secret and setting names, bindings and Worker versions appear with "Show technical names", one choice this browser remembers for every page; and the sign-in secret, the setup secret's removal command and what disabling sandbox builds deletes are under "Technical details". Email settings speak of domains instead of zones.
