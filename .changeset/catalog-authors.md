---
"@appflare/schema": minor
"@appflare/manager": minor
---

Catalog entries name the app's authors separately from the people who package it for the catalog. The catalog manifest takes an optional `authors` list, one or more `{ name, url?, github?, x? }` (an https website, and GitHub and X handles without `@`), and each catalog index row carries `authors`: the manifest's, or the owner of `repo` when it lists none. Adds `catalogAuthorSchema`, `catalogAuthors()` and `authorsFromRepo()`; `authors` stays optional in the index schema so an index published before it existed still parses. The manager's catalog cards show the authors' names; an app's page lists each author with links to their website, GitHub, and X profiles, and shows the catalog maintainers under "Packaged by" (linked to GitHub) instead of "Maintainers".
