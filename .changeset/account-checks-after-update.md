---
"@appflare/manager": patch
---

Protecting an app with Cloudflare Access is refused before anything is created whenever Appflare cannot confirm the account and its Cloudflare token can do it. Before, a check that got no answer from Cloudflare counted as a pass (and an unreadable Zero Trust organization skipped the service token check altogether), installing a reviewed build was not checked at all, and the install made the "Appflare users" policy before it found the Access: Service Tokens permission missing. When Cloudflare cannot be asked, the refusal now says only that, and to try again in a minute.

After Appflare is updated, it also checks what the account and its token can do again on its first request, instead of showing the answers an older version stored until the next day's check, and the catalog shows Cloudflare Access as not checked yet until the service token permission has been checked.
