---
"@appflare/sandbox-worker": minor
---

The sandbox Worker clones private repositories with a GitHub access token it holds as a secret (`GITHUB_TOKEN_<id>`), named by the build request. Only the commands that fetch the repository get the token, as the password of the https clone through git's environment: never on a command line, in the remote URL or in `.git/config`, never in the dependency install or the build, and never in the log. A new `githubFetch` method makes one GET to github.com or api.github.com with a named token for the manager and returns GitHub's answer, redirects unfollowed. `info().features` lists `github-tokens`.
