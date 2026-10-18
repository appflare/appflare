# @appflare/cf-api

## 0.4.1

### Patch Changes

- 973e0ac: Fixed: `client.containers.listApplications()` throws on an answer without the list instead of returning none.
- c0a1cfa: Fixed: `client.d1.listDatabases()` returns every database in an account of more than one page, reading 1,000 per page until a short page or the reported total.
- f091a4e: Fixed: `client.workers.listDurableObjectNamespaces()` returns every namespace in an account of more than one page, and throws on an answer without the list instead of returning none.
- f091a4e: Added: `client.workers.getDurableObjectNamespace(id)` reads one Durable Object namespace; one that no longer exists answers 404.

## 0.4.0

### Added

- `client.usage`: hourly usage per resource from Cloudflare's GraphQL Analytics API, with `batched()` to send reads as one request.
- `client.usage.accountTotals()` reads the whole account's use of what Workers Free limits per day.
- Calls to pause and resume an app's parts: `workers.getScriptSettings`, `workers.setObservability`, `containers.setMaxInstances`, `queues.getQueue` and `queues.setDeliveryPaused`.
- `workflows.listInstances`, `workflows.pauseInstance` and `workflows.resumeInstance` for pausing an app's Workflow instances.
- `missingSpendProtectionScopes` tells whether a grant lacks `account-analytics.read`.

### Changed

- Sign-in asks for `account-analytics.read` and no longer asks for `workers-tail.read`.

## 0.3.0

### Added

- A client can take a function that returns the credential, called before each request, instead of a fixed token.
- `accounts.list()` lists every account a credential can reach.
- `@appflare/cf-api/oauth`: Cloudflare OAuth for a public client (PKCE, authorize, exchange, refresh, revoke) with `CloudflareOAuthError`, and `missingManagerScopes`.
- `hyperdrive.patchConfig` changes a configuration's query caching, and `emailRouting.updateRule` replaces a routing rule in place.

### Changed

- `pipelines.getStream`, `pipelines.getSink` and `WorkflowInfo` type more of Cloudflare's answers: a stream's `schema`, where a sink writes, and `schedules`.

### Fixed

- `queues.listQueues` reads every page of the account's queues instead of only the first.

## 0.2.1

### Added

- `workflows.putWorkflow` creates or updates a Workflow, with `isWorkflowNotFound` and `isWorkflowCronPaidOnly` for Cloudflare's error codes.

## 0.2.0

### Added

- Access applications take `destinations` (`public` hostnames or a `worker`), and their policies can reference reusable policies.
- Calls for reusable Access policies and service tokens, such as `createReusablePolicy` and `createServiceToken`, with `isServiceTokenInUse`.
- `accessAppCoverage(app)` lists every hostname and path an Access application protects.
- `probeAccessServiceTokens` checks whether the token can read Access service tokens; `probeAccountSetup` reports it as `accessServiceTokens`.

### Changed

- `AccessApp` carries `destinations` and `self_hosted_domains`, and its `domain` may be `null`.
- `WorkerScript` and a script upload's answer type the script's `tag`.

## 0.1.0

### Added

- **First public release.** A typed client for the Cloudflare REST API endpoints Appflare uses, among them Workers, D1, KV, R2, Queues, Containers, custom domains and Access.
- Runs in Workers and Node, checks what an account and its plan allow, and updates an Access application in place.
