---
"@appflare/manager": minor
---

A secret the catalog marks `multiline`, such as a GitHub App's PEM private key, is entered in a monospace text area in the install form, the update and repository-build update forms, and the app's settings, instead of a one-line password field that dropped its line breaks and left the app with a key it could not read. Windows line endings become `\n` and spaces or tabs at the end of the last line are dropped; the rest reaches the Worker secret unchanged. A text area cannot hide its text, so the field says the value shows while it is entered and cannot be read back once saved.
