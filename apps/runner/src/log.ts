/**
 * Structured JSON logging to stdout — the runner is a plain daemon (no
 * protocol on its stdio), so this matches the compose stack's other services.
 *
 * Never log a spawn payload: it carries the agent's proxy token, which is a
 * live credential even though every value beside it is a placeholder.
 */
export const log = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): void => {
  process.stdout.write(
    `${JSON.stringify({ level, message, ...extra, time: new Date().toISOString() })}\n`,
  );
};
