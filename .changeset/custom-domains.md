---
"@appflare/manager": minor
---

Serve an installed app on your own domain. An app's page has a new Custom domains section for admins: choose one of your active domains on Cloudflare, enter a hostname in it, and Appflare attaches the app to it. If the hostname already has DNS records, Appflare shows them and replaces them only after you tick that it may. The hostname appears next to the workers.dev URL, each domain has a "Check now" that sends one request to it, and "Remove" detaches it. Uninstalling an app removes its custom domains first, before the Worker. Custom domains need three optional token permissions (Zone: Read, DNS: Edit, Workers Routes: Edit); the token link now includes them, and when the token lacks them the add dialog says which ones and how to add them. Nothing else needs them.
