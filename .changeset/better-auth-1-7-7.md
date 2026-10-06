---
"@appflare/manager": patch
---

Sign-in runs on Better Auth 1.7.7 (was 1.7.5). The database is unchanged, and existing sessions, passwords and passkeys keep working. The security fix in 1.7.7 concerns Magic Link sign-in, which Appflare does not offer. Better Auth now refuses a password longer than 128 characters before checking it; Appflare has never accepted a password that long.
