---
"@appflare/schema": minor
---

Catalog secrets and vars take an optional `link`, `{ "label", "url" }`, shown beside the field in the install, update and settings forms, such as `{ "label": "Get a key", "url": "https://openrouter.ai/settings/keys" }`. `label` is one line of at most 40 characters without leading or trailing spaces; `url` is an https:// URL of at most 500 characters without spaces, user name or password (`catalogFieldLinkSchema`, `CatalogFieldLink`). Help text stays plain text.

A catalog manifest takes an optional top-level `openPath`, such as `"/dashboard"`: where the manager's Open buttons go within the app. It is a path only, at most 128 characters: it starts with `/`, has no query, fragment, empty, `.` or `..` segment, holds letters, digits and `- . _ ~ @ : + = ,`, and may end in `/`; `/` alone is refused (`openPathSchema`, `openPathProblem`, `OPEN_PATH_PATTERN`). `appOpenUrl(address, openPath)` puts it after an app's address. Health checks and `{{appUrl}}` stay the root.

A catalog revision may add, change or remove both: `openPath` joins `REVISABLE_CATALOG_FIELDS`, and a `link` is part of `secrets` and `vars`, which a revision could already change. Managers from before this release strip both keys, as they strip any key they do not know, so an entry may use them without a new requirement: such a manager shows the field without its link and opens the app at its root. The packer and catalog checks refuse both keys until they run this release.
