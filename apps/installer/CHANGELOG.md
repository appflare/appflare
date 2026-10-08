# @appflare/installer

## 0.1.1

### Patch Changes

- Updated dependencies [14277d5]
- Updated dependencies [89a6581]
  - @appflare/schema@0.5.0

## 0.1.0

### Minor Changes

- 0987d9a: The hosted installer: an API that deploys a signed Appflare release into a visitor's own Cloudflare account with the short-lived access token their browser sends with each request. Each request does one bounded step and records progress, so a closed tab can continue later; names and hostnames already in use are refused, and removal deletes only what the installation created.

### Patch Changes

- 0987d9a: A step answer's message now always describes that step. What a finished step said comes back once, as `completed`, instead of showing up under the step after it.
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
