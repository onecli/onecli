import { redactingReplacer } from "./logs/redact";

/**
 * Structured logging to STDERR only — stdout belongs to the transport
 * protocol (JSONL supervisor messages), so a single stray log line there
 * would corrupt the event stream.
 *
 * Every string value is redacted (`redactingReplacer`) on its way out:
 * stderr leaves the sandbox (`docker logs` on self-host, the deployment's
 * log pipeline elsewhere), and error strings routinely echo a proxy URL
 * carrying the agent's credential. Values, not the serialized line: a token
 * after a newline serializes behind `\n`, where a line-level pattern cannot
 * see it.
 */
export const log = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): void => {
  process.stderr.write(
    `${JSON.stringify({ level, message, ...extra, time: new Date().toISOString() }, redactingReplacer)}\n`,
  );
};
