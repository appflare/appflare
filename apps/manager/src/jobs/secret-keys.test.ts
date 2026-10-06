import { describe, expect, it } from "vitest";
import { secretSlots } from "./reconfigure/plan";
import {
  adoptedSecretKeys,
  secretNamesByKey,
  secretPlacements,
  undeclaredSecretNames,
  workerSecretChanges,
  workerSecretValues,
} from "./secret-keys";

const github = { name: "CLIENT_ID", key: "GITHUB_CLIENT_ID" };
const google = { name: "CLIENT_ID", key: "GOOGLE_CLIENT_ID" };
const plain = { name: "ADMIN_PASSWORD" };

describe("secret keys", () => {
  it("knows a secret without a key of its own by its name", () => {
    expect([...secretNamesByKey([github, plain])]).toEqual([
      ["GITHUB_CLIENT_ID", "CLIENT_ID"],
      ["ADMIN_PASSWORD", "ADMIN_PASSWORD"],
    ]);
  });

  it("gives each Worker the values of its own secrets, by the names it reads", () => {
    const values = { GITHUB_CLIENT_ID: "gh", GOOGLE_CLIENT_ID: "goog", ADMIN_PASSWORD: "pw" };
    expect(workerSecretValues([github], values)).toEqual({ CLIENT_ID: "gh" });
    expect(workerSecretValues([google, plain], values)).toEqual({
      CLIENT_ID: "goog",
      ADMIN_PASSWORD: "pw",
    });
    expect(workerSecretValues([github], {})).toEqual({});
  });

  it("translates a settings change for one Worker, with what the version no longer declares", () => {
    const changes = {
      set: { GITHUB_CLIENT_ID: "new", GOOGLE_CLIENT_ID: "other" },
      unset: ["OLD_TOKEN"],
    };
    expect(workerSecretChanges(changes, [github])).toEqual({
      set: { CLIENT_ID: "new" },
      unset: [],
    });
    expect(workerSecretChanges(changes, [plain], new Map([["OLD_TOKEN", "TOKEN"]]))).toEqual({
      set: {},
      unset: ["TOKEN"],
    });
  });

  it("removes an undeclared record without deleting a secret the Worker reads for a declared key", () => {
    const router = { name: "CLIENT_ID", key: "ROUTER_CLIENT_ID" };
    const undeclared = new Map([["CLIENT_ID", "CLIENT_ID"]]);
    expect(workerSecretChanges({ set: {}, unset: ["CLIENT_ID"] }, [router], undeclared)).toEqual({
      set: {},
      unset: [],
    });
    // Removing both does delete it.
    expect(
      workerSecretChanges(
        { set: {}, unset: ["CLIENT_ID", "ROUTER_CLIENT_ID"] },
        [router],
        undeclared,
      ),
    ).toEqual({ set: {}, unset: ["CLIENT_ID"] });
  });

  it("finds the recorded secrets a version no longer declares, by the name the Worker has", () => {
    expect([
      ...undeclaredSecretNames(
        [github],
        [
          { name: "GITHUB_CLIENT_ID", binding: "CLIENT_ID" },
          { name: "SLACK_CLIENT_ID", binding: "CLIENT_ID" },
          { name: "LEGACY", binding: null },
        ],
      ),
    ]).toEqual([
      ["SLACK_CLIENT_ID", "CLIENT_ID"],
      ["LEGACY", "LEGACY"],
    ]);
  });
});

describe("secretSlots with keys", () => {
  it("lists a secret by key, with the name the Worker reads it by, present when recorded by key", () => {
    const slots = secretSlots(
      [
        { ...github, label: "GitHub client ID", generate: undefined, derive: undefined },
        { ...plain, label: "Admin password", generate: "password", derive: undefined },
      ],
      [
        { name: "GITHUB_CLIENT_ID", binding: "CLIENT_ID" },
        // An install from before keys: name and binding are the secret's name.
        { name: "ADMIN_PASSWORD", binding: "ADMIN_PASSWORD" },
        { name: "SLACK_CLIENT_ID", binding: "CLIENT_ID" },
      ],
    );
    expect(slots.map((s) => [s.name, s.envName, s.present, s.declared])).toEqual([
      ["GITHUB_CLIENT_ID", "CLIENT_ID", true, true],
      ["ADMIN_PASSWORD", undefined, true, true],
      ["SLACK_CLIENT_ID", "CLIENT_ID", true, false],
    ]);
  });
});

describe("adoptedSecretKeys", () => {
  const entry = (secrets: Array<Record<string, unknown>>) =>
    ({
      secrets: secrets.map((s) => ({ label: "x", optional: false, seedOnly: false, ...s })),
      install: {
        workers: [
          { name: "router", primary: true },
          { name: "github", primary: false },
        ],
      },
    }) as unknown as Parameters<typeof adoptedSecretKeys>[0];

  it("moves a record onto the new key of a secret every Worker that gets it already has", () => {
    const before = entry([{ name: "CLIENT_ID" }]);
    const after = entry([
      { name: "CLIENT_ID", key: "ROUTER_CLIENT_ID", workers: ["router"] },
      { name: "CLIENT_ID", key: "GITHUB_CLIENT_ID", workers: ["github"] },
    ]);
    const rows = [{ name: "CLIENT_ID", binding: "CLIENT_ID" }];
    expect([...adoptedSecretKeys(after, secretPlacements(before), rows)]).toEqual([
      ["ROUTER_CLIENT_ID", "CLIENT_ID"],
      ["GITHUB_CLIENT_ID", "CLIENT_ID"],
    ]);
  });

  it("takes over nothing a Worker did not have, or a record the version still declares", () => {
    const before = entry([{ name: "CLIENT_ID", workers: ["router"] }]);
    const after = entry([{ name: "CLIENT_ID", key: "GITHUB_CLIENT_ID", workers: ["github"] }]);
    const rows = [{ name: "CLIENT_ID", binding: "CLIENT_ID" }];
    expect(adoptedSecretKeys(after, secretPlacements(before), rows).size).toBe(0);
    const still = entry([
      { name: "CLIENT_ID", workers: ["router"] },
      { name: "TOKEN", key: "CLIENT_ID_2", workers: ["github"] },
    ]);
    expect(adoptedSecretKeys(still, secretPlacements(before), rows).size).toBe(0);
  });
});
