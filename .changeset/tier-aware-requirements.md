---
"@appflare/manager": patch
---

The requirement notes on an app's catalog page and in its install log now match how the app is installed. For an app built in the account's sandbox Worker, the Containers note says the app is built in a container in this account on Workers Paid; for a self-deploying app, that its installer runs in one. Before, both said the app itself runs Containers. A self-deploying app's Email Routing note no longer says Appflare turns Email Routing on and routes the app's addresses, since its own installer deploys it and Appflare sets up no routing for it.
