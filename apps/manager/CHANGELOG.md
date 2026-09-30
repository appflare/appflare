# @appflare/manager

## 0.1.1

### Patch Changes

- c1f2860: The loading indicator no longer pauses on the full logo, which made it look finished. Each arc of the spinning ring now reshapes into its quarter of the logo and the ring closes on the logo's X. The full logo shows only briefly before the ring opens again. The small round hole that used to show in the middle of the logo is gone.

## 0.1.0

### Minor Changes

- 346d608: The first public release of Appflare, a self-hosted app manager that runs as one Worker in your own Cloudflare account. It installs apps from the Appflare catalog or builds them from a GitHub repository, creates the databases, storage and other resources each app needs, and removes them again together with the app. Before anything reaches your account, it checks the signature of every release it installs and the hash of every file in it. Catalog apps update when you choose or automatically, each update can be rolled back to an earlier version, and Appflare updates itself from its own signed releases. Apps can use custom domains in your account and external domains whose DNS you manage elsewhere, and Appflare itself can move from its workers.dev address to a domain of your account. Several people can share one manager, signing in with a password or a passkey, and the manager can sit behind Cloudflare Access. Health checks show whether each app's Worker answers, longer operations run as jobs with their own logs, and notifications tell you when something finishes or needs your attention. Pages load quickly, with Appflare's mark as the loading indicator, and the Documentation link in the account menu opens appflare.dev.

### Patch Changes

- Updated dependencies [346d608]
- Updated dependencies [346d608]
  - @appflare/cf-api@0.1.0
  - @appflare/schema@0.1.0
