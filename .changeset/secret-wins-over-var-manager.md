---
"@appflare/manager": patch
---

An install, update or settings change never sends a var whose name the catalog declares as a secret, whether the wrangler config or a catalog var gives it. Cloudflare refuses to set a secret over a var of the same name (code 10053), and a version upload that sends such a var replaces the kept secret. Artifacts packed from now on carry no such var; this covers older ones.
