---
"@appflare/manager": minor
---

Install from private GitHub repositories. Settings > Account and capabilities gains a GitHub access card: admins add fine-grained, read-only tokens (a label, the repositories each covers, and the token, with a link to GitHub's new-token page filled in with Contents and Metadata read-only), see when each was last used, and delete them. Each token is stored as a secret on the sandbox Worker and never shown again; the database records its label, repositories and last use only, and adding one needs sandbox builds on. "From a repository", "Check for changes" and "Rebuild and update" read a repository that is not public with each token in turn (those naming the repository first, then its owner's, then the others) through the sandbox Worker, and the build clones with the token that worked. Disabling sandbox builds removes the tokens with the sandbox Worker.

One token may be marked for Appflare release downloads: update checks, self-updates and sandbox Worker updates then read the releases through the sandbox Worker with it, and the `GITHUB_TOKEN` secret stays the fallback. Usage data gains the number of tokens, nothing else about them.
