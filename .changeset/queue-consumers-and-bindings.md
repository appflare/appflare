---
"@appflare/schema": minor
"@appflare/pack": minor
"@appflare/manager": minor
"@appflare/cf-api": minor
---

Apps that consume their own queues now install and work. The packer records the wrangler config's `queues.consumers` in the artifact (`worker.queueConsumers`) with their batch size, batch timeout, retries, retry delay, concurrency, and dead-letter queue. A consumed queue is named by the producer binding that sends to it, or, when no binding does (as with most dead-letter queues), by its name in the wrangler config; an HTTP pull consumer or a queue consumed twice fails the pack. `appflare-pack verify` checks that every consumer names one of the Worker's own queue bindings.

Appflare creates a queue of its own for each queue only a consumer names, `<worker name>-<queue name>`, and attaches the app's Worker to every queue it consumes right after uploading it. An update changes a consumer's settings when they change, attaches new consumers, and detaches ones the new version no longer has, once the new version serves; a rollback gives the restored version the consumers it had. An uninstall detaches every consumer before it deletes the Worker or any queue; kept queues stay without a consumer. Consumers appear on the app's page as "Queue consumer".

Update Appflare before installing an app whose artifact records queue consumers: an earlier manager does not read them and would install the app without its consumers, so its queues would never be delivered. Catalog maintainers should publish such an app only once the manager release that reads consumers is out.

Rate limit (`ratelimits`) and Images (`images`) bindings now reach the app, and a `send_email` binding keeps its `destination_address`, `allowed_destination_addresses`, and `allowed_sender_addresses` restrictions instead of losing them. Cloudflare shares a rate limit's counters across every Worker in the account that binds the same `namespace_id`, and apps often ship a placeholder such as `1001`, so Appflare never sends the app's own id: each install gets a random namespace id per rate limit binding, recorded on the app's page as "Rate limit" and kept for every later update and rollback.

The API client can create, list, update, and delete a queue's consumers.
