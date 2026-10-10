import { readFileSync, lstatSync } from "node:fs";
import { z } from "zod";

/** Docker sees only this file's path. Secret values never become container-config environment entries. */
export function loadRuntimeSecrets(
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!path) return;
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 16384
  )
    throw new Error(
      "Runtime secret file must be a small owner-only regular file",
    );
  const values = z
    .object({
      AQUA0_READ_API_KEY: z.string().min(16).max(4096).optional(),
      REBALANCER_REPORT_TOKEN: z.string().min(32).max(512),
      REBALANCER_CONTROL_TOKEN: z.string().min(32).max(512).optional(),
    })
    .strict()
    .parse(JSON.parse(readFileSync(path, "utf8")));
  if (values.REBALANCER_CONTROL_TOKEN === values.REBALANCER_REPORT_TOKEN)
    throw new Error("Runtime report and control credentials must differ");
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) {
      if (env[key] !== undefined && env[key] !== value)
        throw new Error("Ambiguous runtime credential configuration");
      env[key] = value;
    }
}
