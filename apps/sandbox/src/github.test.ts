import { SANDBOX_PROTOCOL_VERSION } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  GithubFetchError,
  githubFetch,
  gitTokenEnv,
  heldGithubToken,
  MAX_GITHUB_FETCH_BYTES,
} from "./github";

const SECRET = "GITHUB_TOKEN_01J8TOKEN00000";
const TOKEN = "github_pat_11AAAAAAA0secretvalue_DO_NOT_LEAK";
const ENV = { [SECRET]: TOKEN, APP_TOKEN_01J8INSTALL: "app-token-value" };

interface Seen {
  url: string;
  init: RequestInit;
}

function recorder(response: () => Response = () => new Response("ok")) {
  const seen: Seen[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { seen, impl };
}

function request(url: string, extra: Record<string, unknown> = {}) {
  return { protocol: SANDBOX_PROTOCOL_VERSION, url, tokenSecret: SECRET, ...extra };
}

describe("heldGithubToken", () => {
  it("reads only GitHub access token secrets", () => {
    expect(heldGithubToken(ENV, SECRET)).toBe(TOKEN);
    expect(heldGithubToken(ENV, "APP_TOKEN_01J8INSTALL")).toBeNull();
    expect(heldGithubToken(ENV, "GITHUB_TOKEN_01J8MISSING00")).toBeNull();
  });
});

describe("gitTokenEnv", () => {
  it("sends the token as the password to github.com only, with prompts off", () => {
    expect(gitTokenEnv(TOKEN)).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${TOKEN}`)}`,
    });
  });
});

describe("githubFetch", () => {
  it("sends the token as Bearer to the API and returns redirects unfollowed", async () => {
    const { seen, impl } = recorder(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://objects.githubusercontent.com/x", "set-cookie": "a=b" },
        }),
    );
    const response = await githubFetch(
      ENV,
      request("https://api.github.com/repos/o/r/releases/assets/1", {
        headers: { accept: "application/octet-stream", range: "bytes=0-9", cookie: "dropped" },
      }),
      impl,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://objects.githubusercontent.com/x");
    expect(response.headers.get("set-cookie")).toBeNull();
    const [call] = seen;
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.method).toBe("GET");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("range")).toBe("bytes=0-9");
    expect(headers.get("accept")).toBe("application/octet-stream");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("user-agent")).toBe("Appflare");
  });

  it("sends the token as the Basic password to github.com (git's smart HTTP)", async () => {
    const { seen, impl } = recorder();
    await githubFetch(
      ENV,
      request("https://github.com/o/private.git/info/refs?service=git-upload-pack"),
      impl,
    );
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe(
      `Basic ${btoa(`x-access-token:${TOKEN}`)}`,
    );
  });

  it("refuses other hosts, plain http, credentials in the URL and other secrets", async () => {
    const { seen, impl } = recorder();
    for (const input of [
      request("https://example.com/o/r"),
      request("http://github.com/o/r"),
      request("https://user:pw@github.com/o/r"),
      request("https://github.com:444/o/r"),
      request("https://github.com/o/r", { tokenSecret: "APP_TOKEN_01J8INSTALL" }),
    ]) {
      await expect(githubFetch(ENV, input, impl)).rejects.toThrow(GithubFetchError);
    }
    expect(seen).toEqual([]);
  });

  it("refuses an answer larger than 8 MiB, by its length or as it streams", async () => {
    const big = recorder(
      () => new Response("x", { headers: { "content-length": String(9 * 1024 * 1024) } }),
    );
    await expect(
      githubFetch(ENV, request("https://api.github.com/repos/o/r/releases"), big.impl),
    ).rejects.toThrow(/more than the 8388608/);

    const streamed = recorder(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const chunk = new Uint8Array(1024 * 1024);
              for (let i = 0; i < 9; i++) controller.enqueue(chunk);
              controller.close();
            },
          }),
        ),
    );
    const response = await githubFetch(
      ENV,
      request("https://api.github.com/repos/o/r/releases"),
      streamed.impl,
    );
    await expect(response.arrayBuffer()).rejects.toThrow(/larger than the 8388608 bytes/);
    expect(MAX_GITHUB_FETCH_BYTES).toBe(8 * 1024 * 1024);
  });

  it("says which token it does not hold, never a value", async () => {
    const { impl } = recorder();
    const error = await githubFetch(
      {},
      request("https://github.com/o/r.git/info/refs?service=git-upload-pack"),
      impl,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubFetchError);
    expect((error as Error).message).toContain(SECRET);
  });
});
