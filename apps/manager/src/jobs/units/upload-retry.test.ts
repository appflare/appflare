import { CloudflareApiError, type ScriptMetadata } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { JobError } from "../errors";
import { StepLog } from "../step-log";
import { uploadRetried } from "./upload-retry";

const refusal = (code: number, message: string) =>
  new CloudflareApiError({
    status: 400,
    method: "PUT",
    path: "/accounts/a/workers/scripts/cut",
    errors: [{ code, message }],
  });
const SPENT = () => refusal(100312, "Completion token has already been consumed");
const SLOW = () => refusal(10021, "Error: Script startup exceeded CPU time limit.");

const METADATA: ScriptMetadata = {
  main_module: "index.js",
  assets: { jwt: "jwt-1" },
} as ScriptMetadata;

/** Answers the uploads in turn: an error to throw, or "ok". */
function upload(answers: Array<Error | "ok">) {
  const sent: Array<string | undefined> = [];
  let tokens = 1;
  const renewed: string[] = [];
  const run = () =>
    uploadRetried(
      async (metadata) => {
        sent.push(metadata.assets?.jwt);
        const answer = answers.shift();
        if (answer === undefined || answer === "ok") return "done";
        throw answer;
      },
      METADATA,
      {
        renewAssets: async () => {
          const jwt = `jwt-${++tokens}`;
          renewed.push(jwt);
          return jwt;
        },
        pause: async () => {},
        log: new StepLog(() => 0),
      },
    );
  return { run, sent, renewed };
}

describe("uploadRetried", () => {
  it("takes a new token again when the upload sent after a slow startup meets a spent one", async () => {
    const u = upload([SPENT(), SLOW(), SPENT(), "ok"]);
    expect(await u.run()).toBe("done");
    expect(u.sent).toEqual(["jwt-1", "jwt-2", "jwt-2", "jwt-3"]);
    expect(u.renewed).toEqual(["jwt-2", "jwt-3"]);
  });

  it("sends a slow startup once more, and takes a new token after it", async () => {
    const u = upload([SLOW(), SPENT(), "ok"]);
    expect(await u.run()).toBe("done");
    expect(u.sent).toEqual(["jwt-1", "jwt-1", "jwt-2"]);
  });

  it("gives up on a token spent twice in a row", async () => {
    const second = SPENT();
    const u = upload([SPENT(), second]);
    await expect(u.run()).rejects.toBe(second);
    expect(u.renewed).toEqual(["jwt-2"]);
  });

  it("says the startup took too long when it is refused twice", async () => {
    const u = upload([SLOW(), SPENT(), SLOW()]);
    await expect(u.run()).rejects.toThrow(JobError);
    await expect(upload([SLOW(), SLOW()]).run()).rejects.toThrow(
      /^the app's startup took too long for Cloudflare/,
    );
  });
});
