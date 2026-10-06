---
"@appflare/cf-api": patch
---

`pipelines.getStream` and `pipelines.getSink` now type the stream's `schema` and where a sink writes (`config.bucket`, `namespace`, `table_name`), as Cloudflare returns them. A sink's credential stays untyped and unread.
