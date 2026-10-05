# @appflare/cf-api

## 0.2.1

### Patch Changes

- 482eb0b: Add `workflows.putWorkflow` (`PUT /workflows/{name}`), which creates or updates a Workflow for a script and class, with `isWorkflowNotFound` and `isWorkflowCronPaidOnly` for the codes Cloudflare answers with.

## 0.2.0

### Minor Changes

- b2e7bfd: Access applications can now protect several addresses at once. `createApp` and `updateApp` take `destinations`, each a `public` hostname (optionally with a path, such as `host/open/*`) or a `worker` destination that covers a Worker's workers.dev URL, every preview URL and its custom domains; `domain` still works, and an application needs one or the other. An application's `policies` can reference reusable policies as `{ id, precedence }` or be written inline, and policy rules are typed for `service_token` and `any_valid_service_token` as well as `email` and `everyone`. `AccessApp` now carries `destinations` and `self_hosted_domains`, and its `domain` may be `null`.
  
  New calls: `listReusablePolicies`, `getReusablePolicy`, `createReusablePolicy`, `updateReusablePolicy` and `deleteReusablePolicy` for account-level reusable policies, and `listServiceTokens`, `createServiceToken` (the only answer with the secret), `deleteServiceToken`, `refreshServiceToken` and `rotateServiceToken` for service tokens. Deleting a service token that a policy still uses is refused with code 12139, exported as `ACCESS_SERVICE_TOKEN_IN_USE`; `isServiceTokenInUse(error)` recognises it. `accessAppCoverage(app)` lists every hostname and path an application protects, from `domain`, `self_hosted_domains` and its `public` destinations, with its `worker` destinations apart. A script upload's answer now types its `tag`, which is what a `worker` destination names.
- b2e7bfd: `probeAccessServiceTokens` reports whether the token can read Access service tokens ("Access: Service Tokens"): `readable` when the list answers (which proves Read, not Edit), `no-permission` when it is refused. `probeAccountSetup` now runs it with the workers.dev, Zero Trust and Analytics Engine probes and answers `accessServiceTokens` next to them.

### Patch Changes

- b2e7bfd: `WorkerScript` (the items of `listScripts`) now types the script's `tag`, the id an Access `worker` destination names a Worker by.

## 0.1.0

### Minor Changes

- 346d608: The first public release of Appflare's typed client for the Cloudflare REST API endpoints it uses, among them Workers, D1, KV, R2, Queues, Containers, custom domains and Access. It runs in Workers and in Node, and can check what an account and its plan allow before an install starts. It can also update an Access application in place, for example to move it to another hostname.
