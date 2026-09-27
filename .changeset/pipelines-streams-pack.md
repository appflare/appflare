---
"@appflare/pack": minor
---

Apps with a Pipelines binding can be packed when the catalog manifest describes the stream under `resources.pipelines`. The artifact records the binding by name only, never the stream id of the author's account (`stream`, or `pipeline`, its name before June 2026). A Pipelines binding the manifest does not describe, or a description the config does not bind, fails the pack before anything is built, naming the binding and the field to fix, and `appflare-pack verify` holds an artifact's Pipelines bindings to its embedded catalog manifest the same way.
