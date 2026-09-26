---
"@appflare/pack": minor
---

Add `appflare-pack keygen --out <file> --key-id <id>`, which makes the signing key pair for a catalog of your own. It writes the Ed25519 private key (base64 PKCS#8, the format `--sign-key-env` and `sign` read) to `<file>` with mode 0600, and refuses to overwrite an existing file or to write one inside a git working tree where it is not ignored. It prints the file's path, the key id, the public key as the one line (`{"keyId":"…","publicKeyBase64":"…"}`) that an Appflare admin pastes into **Settings > Catalogs**, and the key's `SHA256:` fingerprint, which Appflare shows back so the admin can compare it with the one you publish. The private key is never printed. Key ids are lowercase letters, digits and dashes, and never `unsigned`.
