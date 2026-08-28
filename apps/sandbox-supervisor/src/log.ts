/**
 * Structured logging to STDERR only — stdout belongs to the transport
 * protocol (JSONL supervisor messages), so a single stray log line there
 * would corrupt the event stream.
 */
export const log = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): void => {
  process.stderr.write(
    `${JSON.stringify({ level, message, ...extra, time: new Date().toISOString() })}\n`,
  );
};
