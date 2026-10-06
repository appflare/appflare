---
"@appflare/manager": minor
---

An app of several Workers can have a Worker other than the primary one receive its mail (`install.emailRouting.worker`): the install checks the zone for that Worker and points the routing rules and catch-all at it, even when it is off workers.dev, and the install form's preview takes a catch-all already on it as the app's own. An update to a version that names another Worker points the rules and catch-all it keeps at it in place, keeping their ids, and a rollback points them back; a rule found deleted is set up again, and one changed by hand is left alone with a warning. Removing the app's routes (uninstall, updates, settings, setting the email up again) recognises any of its Workers, so a catch-all on another Worker is put back as the install found it. The app's page says which Worker receives the mail when it is not the primary one.

Settings and post-install notes can use `{{emailDomain}}` and `{{emailZoneId}}`, the zone the app receives email for, filled in on install, update and settings change (keys of a JSON var included); moving the app's email to another zone deploys the settings again when they use it, as does a rollback to a version deployed while the email was on another zone, and the settings form offers the email domain as a chip.

A Hyperdrive binding whose entry sets `caching` gets its configuration made with query caching on or off as set, and updates, settings changes and rollbacks set a kept configuration back to it, before the version that sets it serves.
