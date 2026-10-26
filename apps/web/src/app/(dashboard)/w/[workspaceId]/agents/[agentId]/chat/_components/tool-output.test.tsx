// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isErrorLine, ToolOutput } from "./tool-output";

describe("isErrorLine", () => {
  it("marks the shapes tools print for an error", () => {
    expect(
      isErrorLine("ls: cannot open directory '/root': Permission denied"),
    ).toBe(true);
    expect(
      isErrorLine("src/a.ts:3:5: error TS2304: Cannot find name 'x'."),
    ).toBe(true);
    expect(isErrorLine("[stderr] fatal: not a git repository")).toBe(true);
    expect(isErrorLine("Traceback (most recent call last):")).toBe(true);
    expect(isErrorLine('{"error":"This API key is not authorized"}')).toBe(
      true,
    );
    // Shapes taken from real agent runs:
    expect(
      isErrorLine("bash: -c: line 7: syntax error: unexpected end of file"),
    ).toBe(true);
    expect(isErrorLine("sh: tsx: command not found")).toBe(true);
    expect(
      isErrorLine("bash: line 0: cd: /tmp/x: No such file or directory"),
    ).toBe(true);
    expect(isErrorLine("TypeError: Cannot read properties of undefined")).toBe(
      true,
    );
    expect(
      isErrorLine(
        ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "tsx" not found',
      ),
    ).toBe(true);
    expect(
      isErrorLine(
        "grep: src/app/(dashboard)/w/[id]/x.tsx: No such file or directory",
      ),
    ).toBe(true);
    expect(isErrorLine("bash: * 1000 : syntax error: operand expected")).toBe(
      true,
    );
    expect(isErrorLine("⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯")).toBe(true);
    expect(
      isErrorLine(
        "An error occurred (ResourceNotFoundException) when calling X",
      ),
    ).toBe(true);
    expect(isErrorLine("command terminated with exit code 1")).toBe(true);
    expect(isErrorLine("      Tests  3 failed | 6 passed (9)")).toBe(true);
    expect(isErrorLine(" Test Files  1 failed (1)")).toBe(true);
  });

  it("leaves ordinary lines plain, even when they mention an error", () => {
    expect(isErrorLine("--- api/v1/lists ---")).toBe(false);
    expect(isErrorLine('{"id":"019518f3","name":"OneCLI"}')).toBe(false);
    expect(isErrorLine("mcp-server.mdx 404")).toBe(false);
    // A README or grep hit that merely mentions errors is not one.
    expect(isErrorLine("Handle the error before retrying.")).toBe(false);
    expect(isErrorLine("src/retry.ts:12:  if (error) return;")).toBe(false);
    // A config value named like an error word is an assignment, not a failure.
    expect(isErrorLine('panic = "abort"')).toBe(false);
    expect(isErrorLine('69:panic = "deny"')).toBe(false);
    // Real passing-run lines that only mention failure (seen in agent runs).
    expect(isErrorLine("✖ 2 problems (0 errors, 2 warnings)")).toBe(false);
    expect(
      isErrorLine(
        "test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured",
      ),
    ).toBe(false);
    expect(
      isErrorLine("apps/x/src/errors.ts:3:export class ConfigError {"),
    ).toBe(false);
    expect(isErrorLine("      Tests  0 failed | 9 passed (9)")).toBe(false);
    expect(isErrorLine("command terminated with exit code 0")).toBe(false);
    // A runtime's exit-code text is the harness adapter's to read: here it
    // is just a line (old rows still carry it).
    expect(isErrorLine("Exit code: 0")).toBe(false);
    expect(isErrorLine("")).toBe(false);
  });

  it("stays fast on long hostile lines (no catastrophic backtracking)", () => {
    // Linear is ~1ms each; a backtracking pattern never finishes. Each shape
    // targets one way a prefix could be parsed twice.
    const hostile = [
      "a:".repeat(50_000) + "x",
      "[a]b:".repeat(20_000) + "x",
      ">".repeat(100_000) + "x",
      "⎯".repeat(100_000) + "x",
      "line 1:".repeat(15_000) + "x",
      "a".repeat(100_000) + ":x",
    ];
    for (const line of hostile) {
      const start = performance.now();
      expect(isErrorLine(line)).toBe(false);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});

describe("ToolOutput", () => {
  it("renders untrusted output as text, keeps every line, strips ANSI and CR", () => {
    const { container } = render(
      <ToolOutput
        text={
          "<script>alert(1)</script>\r\n\u001b[31mfatal: boom\u001b[0m\nall done"
        }
      />,
    );
    expect(document.querySelector("script")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(
      "<script>alert(1)</script>\nfatal: boom\nall done",
    );
    expect(screen.getByText("fatal: boom")).toHaveClass("text-red-700");
    expect(screen.getByText("all done")).not.toHaveClass("text-red-700");
  });

  it("tints a failed step's panel red and still colors its lines", () => {
    const { container } = render(
      <ToolOutput text={"listing…\nerror: timed out"} failed />,
    );
    expect(container.firstElementChild).toHaveClass("bg-red-50");
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("error: timed out")).toHaveClass("text-red-700");
    expect(screen.getByText("listing…")).not.toHaveClass("text-red-700");
  });
});
