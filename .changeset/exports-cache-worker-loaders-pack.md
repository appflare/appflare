---
"@appflare/pack": minor
---

The packer records three more parts of a wrangler config, in the form wrangler 4.136 uploads them. The `exports` block (declarative Durable Object and entrypoint exports) is recorded as `worker.exports`, keeping the entries of type `durable-object` or `worker` as wrangler does. The `cache` block is recorded as `worker.cacheOptions`. Each `worker_loaders` entry becomes a `worker_loader` binding. Cloudflare offers Worker Loader only on Workers Paid, so a Worker that binds one fails the pack, before anything is built, unless the catalog manifest says `"plan": "paid"`.
