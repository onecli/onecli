// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { exitCodeOf, toneOf, ToolOutput } from "./tool-output";

describe("exitCodeOf", () => {
  it("reads the runtime's trailer, foreground and background", () => {
    expect(exitCodeOf("boom\n\nExit code: 2")).toBe(2);
    expect(
      exitCodeOf("done\n--- Command finished with exit code: 0 ---\n"),
    ).toBe(0);
  });

  it("only counts the LAST line, so quoted text is not the command's", () => {
    expect(exitCodeOf("exit code: 1 means retry\nall good")).toBeNull();
    expect(exitCodeOf("")).toBeNull();
    expect(exitCodeOf(undefined)).toBeNull();
  });
});

describe("toneOf", () => {
  it("colors errors and non-zero exit codes red, exit 0 green", () => {
    expect(toneOf("ls: cannot open directory '/root': Permission denied")).toBe(
      "error",
    );
    expect(toneOf("src/a.ts:3:5: error TS2304: Cannot find name 'x'.")).toBe(
      "error",
    );
    expect(toneOf("[stderr] fatal: not a git repository")).toBe("error");
    expect(toneOf("Traceback (most recent call last):")).toBe("error");
    expect(toneOf('{"error":"This API key is not authorized"}')).toBe("error");
    // Shapes taken from real agent runs:
    expect(
      toneOf("bash: -c: line 7: syntax error: unexpected end of file"),
    ).toBe("error");
    expect(toneOf("sh: tsx: command not found")).toBe("error");
    expect(toneOf("bash: line 0: cd: /tmp/x: No such file or directory")).toBe(
      "error",
    );
    expect(toneOf("TypeError: Cannot read properties of undefined")).toBe(
      "error",
    );
    expect(
      toneOf(' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "tsx" not found'),
    ).toBe("error");
    expect(
      toneOf(
        "grep: src/app/(dashboard)/w/[id]/x.tsx: No such file or directory",
      ),
    ).toBe("error");
    expect(toneOf("bash: * 1000 : syntax error: operand expected")).toBe(
      "error",
    );
    expect(toneOf("⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯")).toBe("error");
    expect(
      toneOf("An error occurred (ResourceNotFoundException) when calling X"),
    ).toBe("error");
    expect(toneOf("command terminated with exit code 1")).toBe("error");
    expect(toneOf("      Tests  3 failed | 6 passed (9)")).toBe("error");
    expect(toneOf(" Test Files  1 failed (1)")).toBe("error");
    expect(toneOf("Exit code: 2")).toBe("error");
    expect(toneOf("Exit code: 0")).toBe("ok");
    expect(toneOf("--- Command finished with exit code: 0 ---")).toBe("ok");
  });

  it("leaves ordinary lines plain, even when they mention an error", () => {
    expect(toneOf("--- api/v1/lists ---")).toBe("plain");
    expect(toneOf('{"id":"019518f3","name":"OneCLI"}')).toBe("plain");
    expect(toneOf("mcp-server.mdx 404")).toBe("plain");
    // A README or grep hit that merely mentions errors is not one.
    expect(toneOf("Handle the error before retrying.")).toBe("plain");
    expect(toneOf("src/retry.ts:12:  if (error) return;")).toBe("plain");
    // A config value named like an error word is an assignment, not a failure.
    expect(toneOf('panic = "abort"')).toBe("plain");
    expect(toneOf('69:panic = "deny"')).toBe("plain");
    // Real passing-run lines that only mention failure (seen in agent runs).
    expect(toneOf("✖ 2 problems (0 errors, 2 warnings)")).toBe("plain");
    expect(
      toneOf("test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured"),
    ).toBe("plain");
    expect(toneOf("apps/x/src/errors.ts:3:export class ConfigError {")).toBe(
      "plain",
    );
    expect(toneOf("      Tests  0 failed | 9 passed (9)")).toBe("plain");
    expect(toneOf("command terminated with exit code 0")).toBe("plain");
    expect(toneOf("")).toBe("plain");
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
      expect(toneOf(line)).toBe("plain");
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});

describe("ToolOutput", () => {
  it("renders untrusted output as text, keeps every line, strips ANSI and CR", () => {
    const { container } = render(
      <ToolOutput
        text={
          "<script>alert(1)</script>\r\n\u001b[31mfatal: boom\u001b[0m\nExit code: 1"
        }
      />,
    );
    expect(document.querySelector("script")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(
      "<script>alert(1)</script>\nfatal: boom\nExit code: 1",
    );
    expect(screen.getByText("fatal: boom")).toHaveClass("text-red-700");
    expect(screen.getByText("Exit code: 1")).toHaveClass("text-red-700");
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
