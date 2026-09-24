---
"@appflare/manager": patch
---

Choices between described options are now choice cards: the address at install time, automatic updates on an app's page, the kind of a new notification channel, the role of a new user, and the Workers plan in Settings. Each card says what the option does.

Custom domain fields, on an app's page and in the install form, ask only for the subdomain and show the chosen domain as a fixed suffix, as the Cloudflare dashboard does. Leaving the subdomain empty serves the app on the domain itself (its root), and a whole hostname pasted in is taken as it is. External domain fields keep asking for the whole hostname. No domain field shows an "https://" prefix any more: they take a hostname, not a URL.

Adding an external domain now asks "How the domain is verified", and its two choices say when each fits: CNAME for a name not in use yet (live in about two minutes, an error until then), TXT records first for a name that already shows another website (no downtime).

Settings, Account and capabilities no longer offers the manual Workers plan choice once Appflare detects the plan. While it cannot, the choice is there, with a hint to add Billing: Read to the token when that is what is missing.

The update card at the bottom of the sidebar no longer repeats the running version (the footer shows it), keeps the same space on both sides, and has its Update button on the right. The footer puts the account menu on the left and the version on the right. The Settings pages in the sidebar sit a little apart from Settings, and only the open page is highlighted. The user row menu has space between its icons and labels.
