# @appflare/cli

## 0.1.0

### Minor Changes

- 5ae5577: `status` shows whether an update is available (`Update available: <version>` or
  `Up to date`) from the manager's health endpoint. `rollback --list` prints recent
  versions with their ids and dates for `--to`, and a rollback now ends with the
  manager's health and version. `uninstall` refuses a Worker that is not an Appflare manager, and
  `uninstall --purge` also deletes the D1 database and KV namespace the manager is
  bound to (by exact name only when the Worker is already gone), after you type the
  manager's name (or with `--yes --purge --i-understand-data-loss`). Release downloads explain a 404
  as a possibly private repository and how to pass `GITHUB_TOKEN`, fetch the files of
  a just-published release by id, and fall back to the previous complete release with
  a warning.
