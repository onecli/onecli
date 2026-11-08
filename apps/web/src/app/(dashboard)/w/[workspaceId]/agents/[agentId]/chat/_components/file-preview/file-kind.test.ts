import { describe, expect, it } from "vitest";
import { previewKind } from "./file-kind";

describe("previewKind: one rule for the composer and the chat", () => {
  it.each([
    ["photo.png", "image/png", "image"],
    ["dpa.pdf", "application/pdf", "pdf"],
    ["dpa.pdf", "application/octet-stream", "pdf"],
    ["export.csv", "text/csv", "text"],
    ["config.yaml", "application/octet-stream", "text"],
    ["notes.docx", "application/vnd.openxmlformats", "card"],
    ["notes.txt", "text/html", "card"],
    ["logo.pdf", "image/svg+xml", "card"],
    ["document.pdf", "application/msword", "card"],
    ["notes.txt", "", "text"],
    ["document.pdf", "", "pdf"],
    ["notes.txt", "application/octet-stream", "text"],
    ["document.pdf", "application/json", "text"],
  ])("%s (%s) previews as %s", (name, mime, kind) => {
    expect(previewKind(name, mime)).toBe(kind);
  });

  it("never renders an SVG as an image (it can carry script)", () => {
    expect(previewKind("logo.svg", "image/svg+xml")).toBe("card");
  });

  it("never treats HTML as text it might render (shown as a plain card)", () => {
    expect(previewKind("page.html", "text/html")).toBe("card");
  });
});
