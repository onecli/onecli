import { describe, expect, it } from "vitest";
import { blockDirection, messageDirection } from "./text-direction";

describe("messageDirection", () => {
  it("is RTL for a Hebrew message and for an Arabic one", () => {
    expect(messageDirection("היי, מה נשמע? בוא נתחיל לעבוד")).toBe("rtl");
    expect(messageDirection("مرحبا، كيف يمكنني مساعدتك اليوم؟")).toBe("rtl");
  });

  it("is LTR for English and for text with no letters", () => {
    expect(messageDirection("Deploy the worker now")).toBe("ltr");
    expect(messageDirection("123 → 456")).toBe("ltr");
    expect(messageDirection("")).toBe("ltr");
  });

  it("keeps an English reply that quotes one Hebrew word LTR", () => {
    expect(
      messageDirection(
        "Your workspace is called שלום and the deploy finished successfully",
      ),
    ).toBe("ltr");
  });

  it("is RTL for a Hebrew message that opens with an English term", () => {
    // dir="auto" would pick LTR here (first strong char is "D").
    expect(
      messageDirection("Dev: אף אחד מ-4 פריטי התוכנית לא נסגר השבוע"),
    ).toBe("rtl");
  });

  it("counts letters only: vowel marks and digits never vote", () => {
    // Pointed Hebrew (niqqud) is the same three letters as unpointed - the
    // marks must not inflate the RTL side of an English sentence.
    const pointed = "שָׁלוֹם";
    expect(
      messageDirection(`${pointed} is how you greet, then continue in English`),
    ).toBe("ltr");
    // Arabic-Indic digits are digits, not letters: no vote either way.
    expect(messageDirection("Order ٣٤٥ shipped today")).toBe("ltr");
  });

  it("ignores URLs and code-ish tokens when voting", () => {
    expect(
      messageDirection(
        "פותחים את https://app.onecli.sh/w/abc/connections?connect=cloudflare",
      ),
    ).toBe("rtl");
    expect(messageDirection("הרצתי `npm run build --workspace=web`")).toBe(
      "rtl",
    );
  });

  it("ignores a fenced code block when voting", () => {
    expect(
      messageDirection(
        "הפלט:\n```\nconst worker = new Worker(script); worker.deploy();\n```",
      ),
    ).toBe("rtl");
  });

  it("stays linear on adversarial input (a 100K run with no whitespace)", () => {
    // Untrusted model text is re-scanned per render. A `\S*X\S*`-shaped
    // filter took seconds on THIS input: a long run with no whitespace and
    // no marker, where `\S*` reaches the end, finds no X, and backtracks
    // from every start position. The bound is generous on purpose; it
    // catches a return to quadratic, not a slow CI box.
    const started = performance.now();
    messageDirection("a".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("blockDirection", () => {
  it("keeps an English-only line LTR inside a Hebrew message", () => {
    expect(blockDirection("Account → Workers Scripts → Edit", "rtl")).toBe(
      "ltr",
    );
  });

  it("reads a Hebrew-majority line RTL even when it starts in English", () => {
    expect(
      blockDirection(
        "Sparklines (גרפי מגמה קטנים) ליד KPIs עם היסטוריה",
        "rtl",
      ),
    ).toBe("rtl");
  });

  it("keeps a mixed line with the message direction", () => {
    const mixed = "Edit Cloudflare Workers תבנית";
    expect(blockDirection(mixed, "rtl")).toBe("rtl");
    expect(blockDirection(mixed, "ltr")).toBe("ltr");
  });

  it("turns RTL inside an LTR message only on an RTL majority", () => {
    expect(blockDirection("שלום עולם, hi", "ltr")).toBe("rtl");
  });
});
