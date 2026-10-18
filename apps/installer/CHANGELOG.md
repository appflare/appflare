# @appflare/installer

## 0.1.4

### Patch Changes

- Updated dependencies [973e0ac]
- Updated dependencies [c0a1cfa]
- Updated dependencies [f091a4e]
- Updated dependencies [f091a4e]
  - @appflare/cf-api@0.4.1

## 0.1.3

- Updated dependencies.

## 0.1.2

- Updated dependencies.

## 0.1.1

- Updated dependencies.

## 0.1.0

### Added

- **The hosted installer.** An API that deploys a signed Appflare release into a visitor's own Cloudflare account with their browser's access token.
- Each request does one step and records progress, so a closed tab can continue later.
- Names and hostnames already in use are refused, and removal deletes only what the installation created.

### Fixed

- A step's answer always describes that step. A finished step's message comes back once, as `completed`.
