---
"@appflare/schema": minor
---

Catalog entries may list the directories whose dependencies the packer installs: `install.installDirs`, an array of 1 to 8 `{ path, packageManager?, lockfile? }`, installed in order. Omitted, it means the root of the checkout alone (`installDirList()`, `DEFAULT_INSTALL_DIRS`). A path is `.` or a relative path of `/`-separated names; absolute paths, `..`, `.` names, backslashes and a directory listed twice are refused with a message naming the problem (`installDirProblem()`). `lockfile: "none"` is for a directory upstream ships without a lockfile. A directory that names no package manager uses `install.packageManager` when it holds that manager's lockfile or none, else the one its lockfile names (`installDirPackageManager()`, `lockfilePackageManager()`, `lockfilesOf()`, `LOCKFILES`). An entry of several Workers lists them once for all its Workers; a self-deploying entry may not list them, since its installer runs without the packer.

`packageManagerSchema` and `PackageManager` now live beside these and are still exported from the package root. A sandbox build's catalog manifest checks `installDirs` with the same rules, and a repository build's detection may report them (`installDirs`, optional, each `{ path, lockfile }`). `SANDBOX_FEATURE_INSTALL_DIRS` names the sandbox Worker feature that builds such entries.
