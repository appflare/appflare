---
"@appflare/manager": patch
---

Installing an app with **Protect with Cloudflare Access** on no longer fails at "cover the app's Workers with Cloudflare Access". Cloudflare fills in an Access application's domain from its first public destination, and Appflare sent that domain back when it switched the application to the app's Workers, which Cloudflare refuses ("domain not included in destinations"). Appflare now leaves the domain out whenever it writes an application's destinations, which also fixes keeping public paths and external domains in step when the first of them goes away.
