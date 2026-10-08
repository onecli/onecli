import { describe, expect, it } from "vitest";
import { prettyJson, tokenizeJson, toolInputPreview } from "./tool-display";

describe("toolInputPreview", () => {
  it("picks the primary argument", () => {
    expect(toolInputPreview('{"command":"echo hello && ls /"}')).toBe(
      "echo hello && ls /",
    );
    expect(toolInputPreview('{"file_path":"/etc/hostname","intent":"x"}')).toBe(
      "/etc/hostname",
    );
    expect(
      toolInputPreview(
        '{"query":"dmarc OR subject:\\"Report\\"","pageSize":50}',
      ),
    ).toBe('dmarc OR subject:"Report"');
  });

  it("clips a long argument to one line", () => {
    const preview = toolInputPreview(
      JSON.stringify({ command: `a\n${"x".repeat(300)}` }),
    );
    expect(preview?.includes("\n")).toBe(false);
    expect(preview?.length).toBeLessThanOrEqual(120);
  });

  it("previews non-JSON input as it is, and has nothing for empty input", () => {
    expect(toolInputPreview("not json")).toBe("not json");
    expect(toolInputPreview(undefined)).toBeNull();
    expect(toolInputPreview("  ")).toBeNull();
  });

  it("has nothing when no primary argument is a non-empty string", () => {
    expect(toolInputPreview('{"limit":5,"command":" "}')).toBeNull();
    expect(toolInputPreview('["a"]')).toBe('["a"]');
  });
});

describe("prettyJson + tokenizeJson", () => {
  it("pretty-prints JSON and leaves other text alone", () => {
    expect(prettyJson('{"a":1}')).toEqual({
      text: '{\n  "a": 1\n}',
      json: true,
    });
    expect(prettyJson("hello\nworld")).toEqual({
      text: "hello\nworld",
      json: false,
    });
    expect(prettyJson("{broken")).toEqual({ text: "{broken", json: false });
  });

  it("tokens concatenate back to the exact input (nothing added or lost)", () => {
    const src = prettyJson(
      '{"query":"a \\"b\\"","n":-1.5e3,"ok":true,"x":null,"arr":[1,"two"]}',
    ).text;
    const tokens = tokenizeJson(src);
    expect(tokens.map((t) => t.text).join("")).toBe(src);
    expect(tokens.find((t) => t.kind === "key")?.text).toBe('"query"');
    expect(tokens.some((t) => t.kind === "number" && t.text === "-1500")).toBe(
      true,
    );
    expect(tokens.some((t) => t.kind === "literal" && t.text === "true")).toBe(
      true,
    );
  });

  it("never throws on hostile text and still round-trips it", () => {
    const hostile =
      '<img src=x onerror=alert(1)> {"a": "\\u0000"} ]]] "unterminated';
    expect(
      tokenizeJson(hostile)
        .map((t) => t.text)
        .join(""),
    ).toBe(hostile);
  });
});
