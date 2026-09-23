---
"@appflare/schema": minor
"@appflare/manager": patch
---

The catalog manifest takes an optional `bump: { "autoMerge": boolean }`. With
`autoMerge: true`, the pull request the catalog's bump bot opens when the app's
upstream moves merges itself once the required checks, the full install check
included, pass; without it a maintainer merges each bump. It is meant for
entries whose maintainers trust upstream's tags to be releasable as they are.

The catalog badge now reads "Install checked" with the day, or "Not checked
yet", and its tooltip says what the check did: the catalog's nightly job
reinstalled this exact package into a test account and it answered. The app's
catalog page labels it "Last checked". "Verified" stays the word for an
install's own health in this account.
