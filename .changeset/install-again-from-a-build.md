---
"@appflare/manager": minor
---

An install from a repository, or of a catalog app built from source, that did not finish now offers Install again too. It opens the review of the build the install was made from, with the install form filled in from last time, and installing removes what the failed install left before it installs that same build again, so nothing is built twice. The build's files stay in the sandbox Worker's bucket for the new install, and go when the new install is uninstalled. When that build is gone, because sandbox builds were turned off or its files are missing, the review says so and offers to build the same repository at the same branch, tag or commit again; that build's review then opens with the same choices. A failed install that left nothing in the account, set aside when a new install takes its Worker name or installs it again, now has its sandbox builds deleted as an uninstall would, except a build another install still uses.
