---
"@appflare/sandbox-worker": minor
"@appflare/cf-api": minor
---

The sandbox Worker runs self-deploying apps' own installers. `deploySelfManaged` and `destroySelfManaged` check out the pinned commit, install dependencies with install scripts disabled, run the entry's build command without credentials, and then run the installer's deploy or destroy command with the stage appended and the app's token, account id, settings and secrets in that one command's environment. The token and secrets come from secrets the manager set on the sandbox Worker for the install; values it knows are redacted from the log it keeps in R2 and returns. After a deploy it reads the expected Workers and their bindings back from the account with the app's token (not the installer's output) and reports every Worker, D1 database, KV namespace, R2 bucket, queue, Vectorize index, Durable Object class and Workflow they own, with the main Worker's workers.dev URL; after a destroy, the Workers that remain. `selfManagedStatus` says whether the token and secrets are held and which Workers exist. `info()` now lists `features: ["self-deploying"]`.

cf-api gains `workers.getSubdomain(name)` (`GET /workers/scripts/{name}/subdomain`).

Before the installer's command runs, any `.env` in the project or at the checkout root is deleted, since Alchemy reads it before the environment. Build and installer requests take an optional `attempt`; a later attempt runs in a container of its own (`-a2`, ...) instead of wiping the work directory of one that may still be running.
