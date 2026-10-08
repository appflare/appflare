# @appflare/sandbox-worker

## 0.1.4

### Patch Changes

- Updated dependencies [14277d5]
- Updated dependencies [89a6581]
  - @appflare/schema@0.5.0

## 0.1.3

### Patch Changes

- db52a31: The sandbox Worker now refuses build containers' HTTPS requests addressed to `api.cloudflare.com`, as it already refused their plain-HTTP ones. It intercepts only the HTTPS connections that name that host, and every other host is still reached directly, so builds fetch their code and dependencies exactly as before. The refusal goes by the host name a request is sent to, so code that connects to the API by IP address or through another server still gets there; what keeps a build from acting on your account is that its container never holds a Cloudflare credential. The installers of self-deploying apps, which deploy through the API, run in two new container classes of their own, `SelfDeployingSandbox` and `LargeSelfDeployingSandbox` (added by the Durable Object migration `v2`), with up to two containers each, so build containers keep the refusal. An installer still gets the app's own token in the environment of its deploy or destroy command only.
- Updated dependencies [0987d9a]
- Updated dependencies [0987d9a]
- Updated dependencies [0987d9a]
- Updated dependencies [bfb0d36]
- Updated dependencies [bfb0d36]
- Updated dependencies [a3b88f6]
- Updated dependencies [bfb0d36]
- Updated dependencies [fe88b64]
- Updated dependencies [f6cab63]
- Updated dependencies [8197a5c]
- Updated dependencies [b890dd0]
- Updated dependencies [03b5bd1]
- Updated dependencies [db52a31]
- Updated dependencies [f71f0b9]
- Updated dependencies [f71f0b9]
  - @appflare/cf-api@0.3.0
  - @appflare/schema@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [afbe792]
- Updated dependencies [c900272]
- Updated dependencies [482eb0b]
- Updated dependencies [482eb0b]
  - @appflare/schema@0.3.0
  - @appflare/cf-api@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [b2e7bfd]
- Updated dependencies [b2e7bfd]
- Updated dependencies [b2e7bfd]
- Updated dependencies [b2e7bfd]
- Updated dependencies [1fa72de]
- Updated dependencies [b2e7bfd]
  - @appflare/cf-api@0.2.0
  - @appflare/schema@0.2.0

## 0.1.0

### Minor Changes

- 346d608: The first public release of the optional sandbox Worker, which you enable from Appflare's Settings on the Workers Paid plan. It builds apps from their source repository inside a Cloudflare Container, so Appflare can install apps that publish no prebuilt release and apps that deploy themselves. It reports each build's progress and log back to the manager.

### Patch Changes

- Updated dependencies [346d608]
- Updated dependencies [346d608]
  - @appflare/cf-api@0.1.0
  - @appflare/schema@0.1.0
