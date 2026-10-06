---
"@appflare/manager": minor
---

Appflare can now be installed from the browser. When the page that installed it finishes, it hands Appflare its connection to Cloudflare directly, then opens Appflare's setup page, where you create the owner account. Only that page can do this: it holds a secret that nothing else, including the installer behind it, ever sees. The link it opens works once and only for 30 minutes. If connecting is interrupted, Appflare keeps what it already received, so trying again from that page continues from there. When it cannot, the page asks you to connect Cloudflare again first. If you installed Appflare on a domain of your own, that domain is Appflare's address from the start, so setup skips the step that asks where Appflare should live. Once the owner exists, Appflare tells the installer it is done, and the installer deletes its record of the installation.

If you open a browser-installed Appflare anywhere else before setup is finished, its setup page tells you to go back to the page that installed it. You can also connect it with a Cloudflare API token instead, as with any other Appflare.
