---
"@appflare/manager": patch
---

The keyboard focus no longer drops to the top of the page after common actions: folding or expanding the sidebar keeps it on the sidebar button, a dialog opened from a user's menu gives it back to that menu (or to "Add user" once the user is deleted), and throwing a build away moves it to the banner that says the build is gone. An app with no domains shows one quiet line per list on its Domains tab instead of two large empty boxes, and the external domains line mentions the gateway, with a link to its settings, only while the gateway is not set up. Errors that appear after an action, such as the apps "Update all" could not start, are announced to screen readers; errors already on the page when it opens keep the same icon as every other error. Three banner titles lost their trailing full stop.
