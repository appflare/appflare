# @appflare/sandbox-worker

## 0.1.7

### Patch Changes

- Updated dependencies [973e0ac]
- Updated dependencies [c0a1cfa]
- Updated dependencies [f091a4e]
- Updated dependencies [f091a4e]
  - @appflare/cf-api@0.4.1

## 0.1.6

- Updated dependencies.

## 0.1.5

- Updated dependencies.

## 0.1.4

- Updated dependencies.

## 0.1.3

### Changed

- Build containers can no longer reach `api.cloudflare.com` over HTTPS either. Every other host works as before.
- Installers of self-deploying apps run in container classes of their own, so build containers keep that refusal.

## 0.1.2

- Updated dependencies.

## 0.1.1

- Updated dependencies.

## 0.1.0

### Added

- **First public release.** The optional sandbox Worker, enabled from Appflare's Settings on Workers Paid, builds apps from source in a Cloudflare Container.
- Appflare can install apps that publish no prebuilt release and apps that deploy themselves, with each build's progress and log.
