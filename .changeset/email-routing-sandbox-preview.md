---
"@appflare/manager": patch
---

Fix installing a sandbox tier app that receives email. The install form's Email Routing preview loaded the app's prebuilt artifact, which a sandbox tier app does not have until the install builds it, so the preview failed and the Install button stayed off. The preview now reads the catalog entry of any tier; for an app that is not built yet it says that whether the app also sends email is unknown until it is built.
