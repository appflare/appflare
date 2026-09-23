---
"@appflare/pack": minor
"@appflare/schema": minor
---

`appflare-pack` warns in its summary when a Worker has more modules than
Appflare can upload in one request on the free plan (`MAX_WORKER_MODULES`,
exported by both packages), and `appflare-pack verify --max-modules <n>` fails
such an artifact, so catalog CI can reject packs Appflare could never install.
