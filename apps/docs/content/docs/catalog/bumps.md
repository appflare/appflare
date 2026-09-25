---
title: Version bumps
description: How the bump bot proposes new upstream versions for catalog apps.
---

Each catalog app is pinned to one upstream commit. A bot proposes moving that pin
when the upstream project moves on. It runs every day.

## What it looks for

For each app, the bot reads the upstream repository's tags:

- If the repository has stable semver tags (`1.2.3` or `v1.2.3`), the newest one by
  version is the target. Pre-release tags are ignored.
- If it has none, the target is the head of the default branch.

Then it compares the target with the current pin:

- A tag pin only moves forward to a newer tag.
- A branch pin moves to a tag once a tag contains the pinned commit, or to a newer
  head of the branch.
- An app that lives in a subdirectory of a larger repository is only bumped when
  files in its directory changed.

## The pull request

When the pin should move, the bot opens a pull request that changes `source` and
nothing else. The branch is `bump/<slug>/<sha7>` and the title is
`chore(<slug>): bump to <ref>`. The description links to the upstream comparison and
lists the new commits. For apps that set `install.version`, it adds a reminder
to change it.

The pull request runs the same checks as a new submission, including the install
check. Merging publishes the new version, and managers show **Update available** at
their next catalog refresh.

A newer bump for the same app closes the older, still-open pull request. An app that
tracks a branch gets at most one bump a week while its last one is still open.

## Who merges a bump

By default, one of the app's maintainers from `CODEOWNERS` reviews the upstream
changes and merges once the checks pass. The merge is their approval.

### Auto-merge

An app whose maintainers trust upstream's tags to be releasable as they are can let
its bumps merge themselves:

```jsonc
"bump": { "autoMerge": true }
```

For such an app, the bot turns on GitHub auto-merge when it opens the pull request.
GitHub squash-merges it once the required checks pass: `verify passed`, which
includes the full install check, and `commit messages`. Auto-merge skips the review,
not the checks. A failing check leaves the pull request open for a maintainer.

Maintainers are still asked to review and can step in until the checks finish:

- To stop one bump, disable auto-merge on the pull request, or close it.
- To stop all future bumps from merging themselves, remove `bump.autoMerge` from the
  app's `appflare.jsonc`, or set it to `false`. Pull requests already open keep
  auto-merge until it is disabled on each.

A bump still waits for a maintainer when:

- the app also sets `install.version`, since someone has to set the new version
  first;
- `verify passed` is not a required check on the catalog's `main` branch, so nothing
  would hold the merge until the install check finished;
- GitHub refuses to turn on auto-merge for the pull request.

The pull request's description says who merges it. In the last two cases the bot also
comments on the pull request to explain why it does not merge itself.

An auto-merged bump is not published at once. GitHub starts no workflows for a merge
that the bot's own token enabled, so the bump workflow's next daily run starts the
publish.

Adding `bump` changes the app's `appflare.jsonc`, and a change to a released version
without a new pin fails to publish. Add it in the same pull request as a move of
`source`, for example on a bump pull request, or raise `revision` by one with it (see
[After merge](/catalog/submit/#after-merge)).
