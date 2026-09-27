---
"@appflare/sandbox-worker": patch
---

The build image carries a packer that packs Workers of static assets only and entries whose `install.installDirs` is empty. For such an entry the install step says that nothing is installed and the build runs with no dependencies installed, and a repository build lists its install directories as none.
