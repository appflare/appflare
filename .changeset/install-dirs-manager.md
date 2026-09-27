---
"@appflare/manager": patch
---

The review of a build from source lists the directories whose dependencies were installed, when the catalog app names them, and marks those installed without an upstream lockfile. A sandbox build of an app that lists `install.installDirs`, from the catalog or from source, is refused before it starts when the sandbox Worker does not list the `install-dirs` feature, with a message to update the sandbox Worker.
