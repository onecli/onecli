/**
 * jcode's bash tool reports a non-zero exit status as text: it appends
 * `\n\nExit code: N` to the command's output and still returns a successful
 * tool result (verified against the pinned v0.94.0 source,
 * `tool/bash.rs` format_command_output). Exit 0, a command promoted to a
 * background task, and a signal kill append nothing.
 *
 * This module turns that vendor text into the protocol's `exitCode` field and
 * strips it from the output, so nothing above the adapter parses jcode's
 * format (invariant 9) and the status survives the runner truncating a long
 * output. Only the exact trailer at the very end counts: the same words
 * anywhere else are the command's own output.
 */

const BASH_TOOL = "bash";
const EXIT_TRAILER = "\n\nExit code: ";
/**
 * A non-zero i32 as jcode formats it: no leading zero, at most ten digits.
 * Anything else, `0` included, is the command's own text, not the trailer.
 */
const EXIT_STATUS = /^-?[1-9]\d{0,9}$/;

export interface JcodeToolOutput {
  output: string;
  /** The non-zero status a shell command exited with, when jcode reported one. */
  exitCode?: number;
}

export const readJcodeToolOutput = (
  name: string,
  output: string,
): JcodeToolOutput => {
  if (name !== BASH_TOOL) return { output };
  const at = output.lastIndexOf(EXIT_TRAILER);
  if (at === -1) return { output };
  const status = output.slice(at + EXIT_TRAILER.length);
  if (!EXIT_STATUS.test(status)) return { output };
  return { output: output.slice(0, at), exitCode: Number(status) };
};
