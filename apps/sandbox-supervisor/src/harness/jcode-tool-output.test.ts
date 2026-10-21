import { describe, expect, it } from "vitest";
import { readJcodeToolOutput } from "./jcode-tool-output";

describe("readJcodeToolOutput", () => {
  it("lifts a non-zero exit status off bash output", () => {
    expect(
      readJcodeToolOutput("bash", "grep: no match\n\nExit code: 1"),
    ).toEqual({ output: "grep: no match", exitCode: 1 });
    // The exact shape jcode writes when the command printed a trailing
    // newline of its own: the extra blank line stays with the output.
    expect(readJcodeToolOutput("bash", "denied\n\n\nExit code: 2")).toEqual({
      output: "denied\n",
      exitCode: 2,
    });
  });

  it("reads a status with no output before it", () => {
    expect(readJcodeToolOutput("bash", "\n\nExit code: 127")).toEqual({
      output: "",
      exitCode: 127,
    });
  });

  it("reads a negative status the way jcode formats an i32", () => {
    expect(readJcodeToolOutput("bash", "x\n\nExit code: -1")).toEqual({
      output: "x",
      exitCode: -1,
    });
  });

  it("leaves output alone when the command reported no status", () => {
    // Exit 0, a background hand-off, and a signal kill append nothing.
    for (const output of [
      "ok",
      "",
      "Command completed successfully (no output)",
      "Command exceeded the foreground timeout after 120.0s and is continuing in background (not killed).",
    ]) {
      expect(readJcodeToolOutput("bash", output)).toEqual({ output });
    }
  });

  it("only counts the exact trailer at the very end", () => {
    for (const output of [
      // The words quoted mid-output are the command's own text.
      "Exit code: 1 means retry\n\nall good",
      "log:\n\nExit code: 1\nthen it recovered",
      // A single newline is not jcode's separator.
      "x\nExit code: 1",
      // Trailing text, whitespace or a non-integer is not the trailer.
      "x\n\nExit code: 1 ",
      "x\n\nExit code: 1\n",
      "x\n\nExit code: one",
      "x\n\nExit code: 1.5",
      "x\n\nExit code: ",
      // jcode appends nothing on exit 0 and never pads, so these are the
      // command's own words.
      "x\n\nExit code: 0",
      "x\n\nExit code: -0",
      "x\n\nExit code: 01",
      // Longer than any i32: not something jcode could have written.
      "x\n\nExit code: 12345678901",
      // A background task's own completion line is a different format.
      "done\n--- Command finished with exit code: 2 ---\n",
    ]) {
      expect(readJcodeToolOutput("bash", output)).toEqual({ output });
    }
  });

  it("reads only the bash tool: other tools' text is their content", () => {
    // `bg status` prints its task's exit code as a field of its report.
    const report = "Task: abc\nStatus: failed\n\nExit code: 1";
    expect(readJcodeToolOutput("bg", report)).toEqual({ output: report });
    expect(readJcodeToolOutput("read", report)).toEqual({ output: report });
    expect(readJcodeToolOutput("mcp__onecli__process_status", report)).toEqual({
      output: report,
    });
  });
});
