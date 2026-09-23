---
"@appflare/schema": minor
"@appflare/pack": minor
"@appflare/manager": minor
---

Vars reach apps the way `wrangler deploy` sends them, and can name the install's own URL.

A wrangler config var whose value is not a string (an array, object, number, boolean, or null) is now recorded as a `json` binding (`{ type: "json", name, json }`) instead of a `plain_text` binding holding its JSON text, and Appflare uploads it as that JSON value. An app with `EMAIL_ADDRESSES: []` now gets an empty array rather than the string `"[]"`. String vars stay `plain_text`. When the catalog manifest lists such a var in `vars`, its `default` must be JSON text; the packer and `appflare-pack verify` refuse one that is not. In the install form, a setting the app reads as JSON is a multi-line field marked JSON that must hold valid JSON before the install can start, and the server checks it again.

`{{workerUrl}}` (the install's workers.dev URL, without a trailing slash) and `{{workerName}}` (its Worker name), already filled in within post-install notes, now work in `vars[].default` and in the values of the wrangler config's own vars, including strings inside JSON values. Appflare fills them in on every install and update with the install's real URL and Worker name, so an app such as FlareMo can get its public URL in a variable. `{{workerUrl}}` is always the workers.dev address, even when a custom domain is attached. The install form shows placeholders filled in for the Worker name being typed. The form now sends and stores only the settings the admin changed, so an untouched setting takes the default of whichever version an install or update deploys. When an update finds a stored value that is not valid JSON for a var the new version reads as JSON (the var was text when the value was entered), it does not fail: the var falls back to the new version's catalog default, else the wrangler config's value, and the job log warns, naming the var. The install job now looks up the account's workers.dev subdomain before it uploads the Worker, and the update job before it uploads the new version. A setting without a catalog default now starts with the wrangler config's value, and that value satisfies a required setting.

Update Appflare before installing an app that relies on either: an earlier manager sends placeholders in vars as written, and when the catalog also lists a JSON var it sends that var twice, once as recorded and once as text.
