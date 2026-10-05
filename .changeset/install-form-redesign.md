---
"@appflare/manager": minor
---

A redesigned install form, shorter and easier to scan.

- **One address control.** The app's address reads as one field: `https://`, the name you type, and the domain, a dropdown at the right. The dropdown lists the account's workers.dev address, every domain on the account and "Another domain, managed elsewhere…", and it has a search box, so accounts with many domains find theirs by typing. Leaving the name empty on one of your domains gives the app the domain itself.
- **Status without layout shift.** A tray under the address always holds one line: "Checking the name…", "Available" with the final address, why a name cannot be used, or the address the app will have. Nothing below it moves while you type or switch domains. On a domain, the Worker name is one quiet line with "Change", and its own field shows its state inside it.
- **Grouped form.** The address and Cloudflare Access come first in their own panel, then "What the app needs" with a count of what is left to fill in, then "Optional settings", folded and naming what it holds. The fold opens by itself when it holds a value, such as on "Install again". Settings Appflare fills in itself are no longer asked; the app's page shows them. The footer says what is left before Install, or where the app will be installed.
- **Optional secrets are one field.** Leave it empty and the secret is not set; there is no "Set it now" switch any more. Help that only repeats "Optional." is shortened, and long help never folds down to a word or two.
- **Quieter generated values.** A generated secret carries a "Generated" badge with a small refresh button (tooltip "Regenerate") instead of a Regenerate link in its help.
- A paid app's plan is confirmed once: when the account's plan is not known, the "Before you install" box's tick also counts for the form, which no longer asks "This account is on Workers Paid" for it. "Remember this for the account" is not offered there; the box's "Choose plan" link records the plan.
- On "Install again", the form starts from the failed install's address (including a domain), Access, name and settings, and says once, next to the fields, that secrets are entered again.
