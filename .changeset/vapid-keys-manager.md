---
"@appflare/manager": minor
---

Apps that send Web Push notifications get their VAPID keys set up for them. The install form fills in a new VAPID private key for a `generate: "vapid-private-key"` secret, and the manager refuses a value that is not one. A var derived from it (`derive: { method: "vapid-public-key" }`) is computed with WebCrypto at install, stored with the app's settings, and computed again whenever the private key gets a new value in the app's settings or an update; an update that adds such a var asks for the private key again, since its value cannot be read back, and leaves the field empty so the key is kept by pasting it rather than rotated unasked. The install and settings forms show the derived var read-only, with the secret it comes from.
