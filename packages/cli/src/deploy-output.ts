import { z } from "zod";

/**
 * wrangler writes one JSON object per line to `WRANGLER_OUTPUT_FILE_PATH`
 * (wrangler 4.136, `writeOutput`). The `deploy` entry lists the deployed
 * targets, including `https://<name>.<subdomain>.workers.dev` when workers.dev
 * is enabled, which is sturdier than scraping the human-readable output.
 */
const deployEntrySchema = z.looseObject({
  type: z.literal("deploy"),
  worker_name: z.string().nullable().optional(),
  version_id: z.string().nullable().optional(),
  targets: z.array(z.string()).optional(),
});

/** What a deploy reported. */
export interface DeployOutput {
  /** `https://<name>.<subdomain>.workers.dev` */
  url: string;
  versionId: string | null;
}

/** Extracts the workers.dev URL and version id of Worker `name` from wrangler's output file. */
export function parseDeployOutput(ndjson: string, name: string): DeployOutput {
  let entry: z.infer<typeof deployEntrySchema> | undefined;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = deployEntrySchema.safeParse(value);
    if (parsed.success) {
      entry = parsed.data;
    }
  }
  if (!entry) {
    throw new Error("wrangler did not report a deploy");
  }
  const url = (entry.targets ?? []).find((target) => {
    try {
      const u = new URL(target);
      return (
        u.protocol === "https:" &&
        u.hostname.startsWith(`${name}.`) &&
        u.hostname.endsWith(".workers.dev")
      );
    } catch {
      return false;
    }
  });
  if (!url) {
    throw new Error(
      `wrangler deployed ${name} but reported no workers.dev URL (targets: ${(entry.targets ?? []).join(", ") || "none"})`,
    );
  }
  return { url: new URL(url).origin, versionId: entry.version_id ?? null };
}
