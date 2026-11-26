import { describe, expect, it } from "vitest";
import { safeUrlTransform } from "./safe-url";

/**
 * The second, independent URL gate under the chat's markdown (the sanitize
 * step is the first). Pins the allowlist so a renderer swap can never widen
 * what a model-written link or image may point at.
 */
describe("safeUrlTransform", () => {
  it("keeps the protocols a chat link may use", () => {
    for (const url of [
      "https://example.com/a?b=c#d",
      "http://example.com",
      "mailto:someone@example.com",
      "HTTPS://EXAMPLE.COM",
    ]) {
      expect(safeUrlTransform(url)).toBe(url);
    }
  });

  it("keeps relative URLs, including a colon in the path, query or fragment", () => {
    for (const url of ["/w/a/connections", "docs/a:b", "?q=a:b", "#x:y"]) {
      expect(safeUrlTransform(url)).toBe(url);
    }
  });

  it("empties every other scheme", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/png;base64,AAAA",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "tel:+15550100",
      "streamdown:incomplete-link",
    ]) {
      expect(safeUrlTransform(url), url).toBe("");
    }
  });
});
