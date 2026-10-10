import { lstatSync, readFileSync } from "node:fs";

/** Rotatable owner-provisioned AWS session. Never use a baked-in secret or print its contents. */
export function readAwsSessionFile(path: string, now = Date.now()) {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16384
    )
      throw new Error();
    const value = JSON.parse(readFileSync(path, "utf8"));
    const allowed = new Set([
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "expiration",
    ]);
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      typeof value.accessKeyId !== "string" ||
      !/^[A-Z0-9]{16,128}$/.test(value.accessKeyId) ||
      typeof value.secretAccessKey !== "string" ||
      value.secretAccessKey.length < 32 ||
      value.secretAccessKey.length > 256 ||
      (value.sessionToken !== undefined &&
        (typeof value.sessionToken !== "string" ||
          value.sessionToken.length < 16 ||
          value.sessionToken.length > 12000))
    )
      throw new Error();
    const expiration =
      value.expiration === undefined ? undefined : new Date(value.expiration);
    if (
      expiration &&
      (!Number.isFinite(expiration.getTime()) ||
        expiration.getTime() <= now + 30_000)
    )
      throw new Error();
    return {
      accessKeyId: value.accessKeyId as string,
      secretAccessKey: value.secretAccessKey as string,
      ...(value.sessionToken
        ? { sessionToken: value.sessionToken as string }
        : {}),
      ...(expiration ? { expiration } : {}),
    };
  } catch {
    throw new Error(
      "Dedicated AWS session file is missing, unsafe, invalid or expired; no credential fallback is permitted",
    );
  }
}
