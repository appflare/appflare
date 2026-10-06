---
"@appflare/cf-api": minor
---

A client can take a function that returns the credential instead of a fixed token. It is called before each request, so a client that lives through a long job always sends a current credential; when it fails, nothing is sent. Asset-upload requests keep using their own upload token.
