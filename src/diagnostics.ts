export function safeError(error: unknown): string {
  const message =
    error instanceof Error
      ? (error.message.split("\n")[0] ?? error.name)
      : "Unknown failure";
  return message
    .replace(/https?:\/\/\S+/gi, "[RPC or API URL]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted]")
    .slice(0, 220);
}
