#!/usr/bin/env node
// Prints a fresh Ed25519 keypair for TEST use only: a base64 PKCS#8 private key
// and the matching raw base64 public key. This is NOT the production catalog
// signing key. Use the private key with
// `appflare-pack --sign-key-env` and the public key with
// `appflare-pack verify --public-key`.
import { webcrypto as crypto } from "node:crypto";

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
  "base64",
);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
  "base64",
);

process.stdout.write("# appflare-pack TEST keypair (do not use in production)\n");
process.stdout.write(`APPFLARE_TEST_SIGN_KEY=${privateKey}\n`);
process.stdout.write(`APPFLARE_TEST_PUBLIC_KEY=${publicKey}\n`);
