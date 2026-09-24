import { describe, expect, it } from "vitest";
import {
  cleanReleaseBody,
  isUnread,
  newestVersion,
  pickReleaseNotes,
  RELEASE_BODY_MAX_CHARS,
  type ReleaseNote,
  unreadCount,
  unreadLabel,
} from "./release-notes";

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    name: `Release ${tag}`,
    body: `Notes for ${tag}`,
    html_url: `https://github.com/appflare/appflare/releases/tag/${encodeURIComponent(tag)}`,
    draft: false,
    prerelease: false,
    published_at: "2026-09-23T13:35:49Z",
    ...extra,
  };
}

function note(version: string): ReleaseNote {
  return {
    tag: `manager@${version}`,
    version,
    name: `Appflare ${version}`,
    publishedAt: null,
    body: "",
    url: "https://github.com/appflare/appflare/releases",
  };
}

describe("pickReleaseNotes", () => {
  it("keeps published Appflare releases only, newest version first", () => {
    const notes = pickReleaseNotes([
      release("manager@0.3.1"),
      release("sandbox@0.1.2"),
      release("manager@0.4.0"),
      release("manager@0.5.0", { draft: true }),
      release("manager@0.5.0-rc.1", { prerelease: true }),
      release("cli@0.4.0"),
      release("manager@latest"),
      release("manager@0.10.0"),
      { not: "a release" },
    ]);
    expect(notes.map((n) => n.version)).toEqual(["0.10.0", "0.4.0", "0.3.1"]);
    expect(notes[1]).toEqual({
      tag: "manager@0.4.0",
      version: "0.4.0",
      name: "Release manager@0.4.0",
      publishedAt: "2026-09-23T13:35:49Z",
      body: "Notes for manager@0.4.0",
      url: "https://github.com/appflare/appflare/releases/tag/manager%400.4.0",
    });
  });

  it("keeps at most ten, and each version once", () => {
    const list = Array.from({ length: 14 }, (_, i) => release(`manager@0.${i}.0`));
    const notes = pickReleaseNotes([...list, release("manager@0.13.0", { body: "again" })]);
    expect(notes).toHaveLength(10);
    expect(notes[0]?.version).toBe("0.13.0");
    expect(notes[0]?.body).toBe("Notes for manager@0.13.0");
    expect(notes.at(-1)?.version).toBe("0.4.0");
  });

  it("fills a missing title, body and date, and trusts only the repository's release pages", () => {
    const [picked] = pickReleaseNotes([
      release("manager@0.2.0", {
        name: "  ",
        body: null,
        published_at: null,
        html_url: "https://evil.example/releases/tag/manager@0.2.0",
      }),
    ]);
    expect(picked).toEqual({
      tag: "manager@0.2.0",
      version: "0.2.0",
      name: "Appflare 0.2.0",
      publishedAt: null,
      body: "",
      url: "https://github.com/appflare/appflare/releases/tag/manager%400.2.0",
    });
  });

  it("reads nothing from a response that is not a list", () => {
    expect(pickReleaseNotes({ message: "Not Found" })).toEqual([]);
    expect(pickReleaseNotes(null)).toEqual([]);
  });
});

describe("cleanReleaseBody", () => {
  it("drops the commit ids changesets puts before each entry", () => {
    const body = [
      "### Minor Changes",
      "",
      "- e9aef76: Apps that bind a Vectorize index can be installed.",
      "  `resources.vectorize`, keyed by binding name.",
      "",
      "### Patch Changes",
      "",
      "- 1d222e9: List an app's account requirements.",
      "- Keeps an entry without a commit id: abc.",
    ].join("\r\n");
    expect(cleanReleaseBody(body)).toBe(
      [
        "### Minor Changes",
        "",
        "- Apps that bind a Vectorize index can be installed.",
        "  `resources.vectorize`, keyed by binding name.",
        "",
        "### Patch Changes",
        "",
        "- List an app's account requirements.",
        "- Keeps an entry without a commit id: abc.",
      ].join("\n"),
    );
  });

  it("cuts a very long body", () => {
    const cut = cleanReleaseBody("x".repeat(RELEASE_BODY_MAX_CHARS + 500));
    expect(cut.length).toBeLessThan(RELEASE_BODY_MAX_CHARS + 10);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("unread release notes", () => {
  const notes = ["0.6.0", "0.5.0", "0.4.0", "0.3.1", "0.3.0"].map(note);

  it("before the first look, counts the running version and every newer release", () => {
    expect(unreadCount(notes, null, "0.4.0")).toBe(3);
    expect(unreadCount(notes, null, "0.6.0")).toBe(1);
    // A version with no release notes stored (a newer build than the feed knows).
    expect(unreadCount(notes, null, "0.7.0")).toBe(0);
  });

  it("counts releases newer than the last one seen", () => {
    expect(unreadCount(notes, "0.4.0", "0.4.0")).toBe(2);
    expect(unreadCount(notes, "0.6.0", "0.4.0")).toBe(0);
    expect(unreadCount(notes, "0.3.0", "0.6.0")).toBe(4);
    expect(isUnread(note("0.5.0"), "0.4.0", "0.4.0")).toBe(true);
    expect(isUnread(note("0.4.0"), "0.4.0", "0.4.0")).toBe(false);
  });

  it("treats a local build as older than every release", () => {
    expect(unreadCount(notes, null, "0.0.0-dev")).toBe(5);
  });

  it("caps the badge at 9+ and finds the newest version", () => {
    expect(unreadLabel(3)).toBe("3");
    expect(unreadLabel(9)).toBe("9");
    expect(unreadLabel(10)).toBe("9+");
    expect(newestVersion(notes)).toBe("0.6.0");
    expect(newestVersion([])).toBeNull();
  });
});
