import { describe, expect, it } from "vitest";
import {
  advertisementUrl,
  GitRefError,
  listRemoteRefs,
  parseAdvertisement,
  resolveRef,
} from "./git-refs";

const MAIN = "6cb1ba365fd6b395a116ab6d1734e19f9d9a0d65";
const TAG_OBJECT = "1111111111111111111111111111111111111111";
const TAGGED = "2222222222222222222222222222222222222222";
const LIGHT = "3333333333333333333333333333333333333333";

/** One pkt-line: four hex digits of length (itself included), then the data. */
function pkt(data: string): string {
  return `${(data.length + 4).toString(16).padStart(4, "0")}${data}`;
}

/** The advertisement GitHub answers `info/refs?service=git-upload-pack` with (git protocol v0). */
const ADVERTISEMENT = [
  pkt("# service=git-upload-pack\n"),
  "0000",
  pkt(`${MAIN} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main agent=git/github\n`),
  pkt(`${MAIN} refs/heads/main\n`),
  pkt(`${LIGHT} refs/heads/feat/home\n`),
  pkt(`${TAG_OBJECT} refs/tags/v1.0.0\n`),
  pkt(`${TAGGED} refs/tags/v1.0.0^{}\n`),
  pkt(`${LIGHT} refs/tags/light\n`),
  "0000",
].join("");

describe("parseAdvertisement", () => {
  it("reads every ref and the branch HEAD points at", () => {
    const remote = parseAdvertisement(ADVERTISEMENT);
    expect(remote.head).toBe("refs/heads/main");
    expect(remote.refs.get("refs/heads/feat/home")).toBe(LIGHT);
    expect(remote.refs.get("refs/tags/v1.0.0^{}")).toBe(TAGGED);
  });

  it("reads an empty repository as having no refs", () => {
    const empty = [
      pkt("# service=git-upload-pack\n"),
      "0000",
      pkt(`${"0".repeat(40)} capabilities^{}\0agent=git/github\n`),
      "0000",
    ].join("");
    expect(parseAdvertisement(empty).refs.size).toBe(0);
  });

  it("refuses anything that is not an advertisement", () => {
    expect(() => parseAdvertisement("<html>Sign in</html>")).toThrow(GitRefError);
  });
});

describe("resolveRef", () => {
  const remote = parseAdvertisement(ADVERTISEMENT);

  it("resolves the default branch, a branch with a slash, and tags peeled to their commit", () => {
    expect(resolveRef(remote, null, "o/r")).toEqual({ commit: MAIN, ref: "main", kind: "branch" });
    expect(resolveRef(remote, "feat/home", "o/r")).toMatchObject({ commit: LIGHT, kind: "branch" });
    expect(resolveRef(remote, "v1.0.0", "o/r")).toEqual({
      commit: TAGGED,
      ref: "v1.0.0",
      kind: "tag",
    });
    expect(resolveRef(remote, "light", "o/r")).toMatchObject({ commit: LIGHT, kind: "tag" });
  });

  it("takes a full commit as it is, and refuses a name the repository does not have", () => {
    expect(resolveRef(remote, "a".repeat(40), "o/r")).toMatchObject({ kind: "commit" });
    expect(() => resolveRef(remote, "nope", "o/r")).toThrow("o/r has no branch or tag named nope");
  });
});

describe("listRemoteRefs", () => {
  it("reads the advertisement from github.com without a token", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const remote = await listRemoteRefs(async (url, init) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return new Response(ADVERTISEMENT, { status: 200 });
    }, "MendyLanda/cut");
    expect(seen[0]?.url).toBe(advertisementUrl("MendyLanda/cut"));
    expect(seen[0]?.url).toBe(
      "https://github.com/MendyLanda/cut.git/info/refs?service=git-upload-pack",
    );
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(remote.head).toBe("refs/heads/main");
  });

  it("says a missing or private repository is not public", async () => {
    await expect(
      listRemoteRefs(async () => new Response("", { status: 401 }), "o/private"),
    ).rejects.toThrow("o/private was not found on GitHub, or is not public.");
  });
});
