# create-appflare

## 0.1.0

### Minor Changes

- 346d608: The first public release of the Appflare installer. `npx create-appflare` checks your Cloudflare login, picks the account, downloads the latest signed Appflare release, verifies it and deploys it, then prints the address where you finish setup. `npx create-appflare recover` lets whoever controls the Cloudflare account get an admin back in after a forgotten password.
