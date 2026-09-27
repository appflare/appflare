---
"@appflare/pack": minor
---

The packer installs each directory of `install.installDirs` in order, the root alone when the entry lists none, always with install scripts disabled. Every listed directory is checked before the first install runs: it must exist and stay inside the checkout, symlinks included, and it must have its package manager's lockfile in it or above it in the checkout, since classic yarn and bun install without one even when frozen. A directory with `lockfile: "none"` is installed without a frozen lockfile (`pnpm install --no-frozen-lockfile`, `npm install`, `yarn install`, `bun install`, each with `--ignore-scripts`), and the pack log records the sha256 of the lockfile the install wrote or changed; a workspace lockfile the install left as it was is logged as such, not as resolved. Such a directory may not hold a lockfile of its own. `installDependencies()`, `installInvocation()`, `resolveInstallDir()` and `findLockfile()` are exported.
