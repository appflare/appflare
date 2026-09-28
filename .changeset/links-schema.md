---
"@appflare/schema": patch
---

A small `links` entry point holds the slug pattern and the GitHub repository parsing without the validation library, so browser pages can use them cheaply; `isGithubRepository`, `isGitRef` and `isCommitSha` are exported. A repository link with a malformed escape is refused instead of throwing.
