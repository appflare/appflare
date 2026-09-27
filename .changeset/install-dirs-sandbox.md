---
"@appflare/sandbox-worker": patch
---

A sandbox build of an entry that lists `install.installDirs` skips the root install and lets the image's packer install those directories, so a template repository with no root `package.json` or lockfile builds. A failed install there is reported as the install step, and a repository build of such a catalog app names the directories in its log and detection. `info().features` lists `install-dirs`, and the manager refuses to send such an entry to a sandbox Worker that lacks it.
