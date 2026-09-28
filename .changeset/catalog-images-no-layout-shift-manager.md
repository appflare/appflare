---
"@appflare/manager": patch
---

Catalog images keep their place while they load. Screenshots sit in 16:10 boxes (the catalog gives no dimensions, so each one is fitted inside), covers in 1200x630 boxes and icons and avatars in squares, all sized before the image arrives, so the gallery, its arrows and "1 of 2" counter, the large view and everything below them stay still. A box shows a skeleton until its image loads, then the image fades in (at once with reduced motion); an image the browser already has shows straight away. A screenshot that fails leaves a plain box instead of a broken-image icon. In the strip a portrait screenshot shows its top across the whole box rather than a thin strip; the large view shows all of it. The first screenshot and the icon at the top of an app's page load at once; the others load as they come into view.
