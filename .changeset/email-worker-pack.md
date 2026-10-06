---
"@appflare/pack": minor
---

The packer accepts `{{emailDomain}}` and `{{emailZoneId}}` in the wrangler config's vars and service binding props of an entry with `install.emailRouting`, refuses them in any other, and checks placeholders in a JSON var's keys as well as its values.
