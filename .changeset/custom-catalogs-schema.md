---
"@appflare/schema": patch
---

Add helpers for public keys that people paste and compare: `formatPublicKey` writes a key as the one-line `{"keyId":"…","publicKeyBase64":"…"}` a catalog publishes, `parsePublicKeys` reads that line (or a list of up to four keys for a rotation) and refuses unreadable key ids, the `unsigned` id, duplicates and keys that are not 32 bytes, and `publicKeyFingerprint` gives a key's `SHA256:` fingerprint in the form OpenSSH prints.
