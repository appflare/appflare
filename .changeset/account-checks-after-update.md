---
"@appflare/manager": patch
---

Protecting an app with Cloudflare Access now starts only after Appflare has read, live, that the account has a Zero Trust organization and that the token can read Access applications, policies and service tokens; a read the token is refused, or one Cloudflare does not answer, stops it before anything is created. Before, a read that got no answer counted as a pass (and an unreadable Zero Trust organization skipped the service token read altogether), installing a reviewed build was not checked at all, and the install made the "Appflare users" policy before it read service tokens. A token that can read service tokens but not create them still gets that far before it is refused. When Cloudflare cannot be asked, the refusal now says only that, and to try again in a minute.

After Appflare is updated, it also checks what the account and its token can do again on its first request, instead of showing the answers an older version stored until the next day's check, and the catalog shows Cloudflare Access as not checked yet until the service token permission has been checked.
