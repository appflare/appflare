---
"@appflare/manager": patch
---

Every place that asks for one of your domains (adding a custom or wildcard domain, the gateway, Appflare's own address, and an app's Email group) now has a searchable list, so an account with many domains is easier to pick from. On an app's Domains tab, custom and external domains share one list layout, each row's Check now button names its hostname for screen readers, empty lists show a short empty state, and the add buttons read "Add domain", "Add wildcard domain" and "Add external domain". A failed check now shows its error in error colour with working links and is announced to screen readers, on the Domains tab, the app's health row and the gateway's domain check.
