---
"@appflare/manager": minor
---

Reorganise the manager around Home, Catalog, Jobs and Settings. Settings is split into pages (General, Account and capabilities, Users and access, Usage data, Notifications, Removed apps, Appflare updates) listed under it in the sidebar; an app's page has tabs (Overview, Settings, Domains and email, Resources, Jobs) with the danger zone at the bottom of Overview, and is titled with the app's name and icon. A new Jobs page lists recent jobs of every app and of Appflare itself. Pages below another one show breadcrumbs.

Every dialog is a Kumo layer dialog whose body scrolls on short screens while its buttons stay in view, so no dialog can end below the viewport. Uninstall, deleting kept data, forgetting an app and removing a notification channel use Kumo's delete confirmation, and starting a job shows a toast before its log opens. Dates read the same everywhere, with the exact time in a tooltip. Catalog cards in a row are equally tall, never cut an app's name short, and mark requirements the account meets; the sort control sits on one line; an app's cover sits beside its details; requirements the account is detected to meet are shown as met rather than as a warning. Home lists each app with its icon. The generic webhook URL is an ordinary URL field, and bot tokens and Slack or Discord webhook URLs use Kumo's sensitive input.

Undoing a settings change is worded as such (no rollback "from a version to itself" and no database warning, since the code is the same), and after a settings change a plain 404 from the app's URL, which was already serving, counts as serving at once instead of waiting out the 90 second health window.

A notification channel whose credentials can no longer be read (after `BETTER_AUTH_SECRET` changed) can be repaired by editing it and entering its details again; a generic webhook repaired this way gets a new signing secret, shown once. Removing the channel and adding it again keeps working.
