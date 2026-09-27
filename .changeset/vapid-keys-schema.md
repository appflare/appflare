---
"@appflare/schema": minor
---

A catalog secret can say `generate: "vapid-private-key"`: the install form fills in a new Web Push (VAPID) private key, a P-256 key as the unpadded base64url of its 32 raw bytes, the format web-push libraries take. A var, as well as a secret, can say `derive: { from, method: "vapid-public-key" }` to be computed from that secret as the unpadded base64url of its 65-byte uncompressed public point. The manifest refuses a derived var whose source is not a non-optional `vapid-private-key` secret of the same manifest, one with a `default`, `type`, `options` or `required: true`, and derived vars on self-deploying entries. `generateVapidPrivateKey`, `vapidPublicKey`, `isVapidPrivateKey` and `secretValueProblem` are exported for the manager and tooling.
