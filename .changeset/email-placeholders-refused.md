---
"@appflare/schema": patch
"@appflare/pack": patch
---

`{{emailDomain}}` and `{{emailZoneId}}` are now refused in an entry without `install.emailRouting`, in var defaults, config patches, post-install notes and the wrangler config's vars and service binding props. Before, they were not placeholders and were passed to the app as written; an entry that used that text for its own purposes must rename it or receive email.
