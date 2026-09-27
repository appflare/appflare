---
"@appflare/sandbox-worker": patch
---

The container image carries a packer that accepts a Worker of any number of modules and fails a build, with the reason, when the Worker does not fit one Appflare upload: its modules add up to more than 32 MiB, or they lie so far apart in the artifact that reading them would take more than 42 subrequests (the release redirect and one per range).
