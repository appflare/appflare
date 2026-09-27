---
"@appflare/pack": minor
---

`deriveSecretValue` computes `vapid-public-key` values (the unpadded base64url of the 65-byte uncompressed P-256 point of a VAPID private key), and `generateVapidPrivateKey` is exported, so tooling that installs an artifact outside the manager can fill in an app's VAPID keys.
