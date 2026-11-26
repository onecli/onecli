import { describe, expect, it } from "vitest";
import {
  KEYBOARD_SENTINEL,
  XK_BACKSPACE,
  XK_RETURN,
  XK_TAB,
  keysymFor,
  keystrokesFor,
} from "./keyboard-bridge";

describe("keysymFor", () => {
  it("maps Latin-1 one to one, the rest into X11's Unicode keysym range", () => {
    expect(keysymFor("a")).toBe(0x61);
    expect(keysymFor("Z")).toBe(0x5a);
    expect(keysymFor("@")).toBe(0x40);
    expect(keysymFor(" ")).toBe(0x20);
    expect(keysymFor("é")).toBe(0xe9);
    expect(keysymFor("€")).toBe(0x010020ac);
    expect(keysymFor("😀")).toBe(0x0101f600);
  });

  it("types newline as Return and tab as Tab, and drops other control characters", () => {
    expect(keysymFor("\n")).toBe(XK_RETURN);
    expect(keysymFor("\r")).toBe(XK_RETURN);
    expect(keysymFor("\t")).toBe(XK_TAB);
    expect(keysymFor("\u0007")).toBeNull();
    expect(keysymFor("\u007f")).toBeNull();
  });
});

describe("keystrokesFor", () => {
  it("types what was appended", () => {
    expect(keystrokesFor(KEYBOARD_SENTINEL, `${KEYBOARD_SENTINEL}hi`)).toEqual([
      0x68, 0x69,
    ]);
  });

  it("sends BackSpace for what was deleted, even into the sentinel", () => {
    expect(
      keystrokesFor(`${KEYBOARD_SENTINEL}ab`, `${KEYBOARD_SENTINEL}a`),
    ).toEqual([XK_BACKSPACE]);
    expect(
      keystrokesFor(KEYBOARD_SENTINEL, KEYBOARD_SENTINEL.slice(1)),
    ).toEqual([XK_BACKSPACE]);
  });

  it("an autocorrect replacing a word is BackSpaces then the new word", () => {
    expect(keystrokesFor("__teh", "__the ")).toEqual([
      XK_BACKSPACE,
      XK_BACKSPACE,
      0x68,
      0x65,
      0x20,
    ]);
  });

  it("counts code points, so an emoji is one key and one BackSpace", () => {
    expect(keystrokesFor("_", "_😀")).toEqual([0x0101f600]);
    expect(keystrokesFor("_😀", "_")).toEqual([XK_BACKSPACE]);
  });

  it("an unchanged value sends nothing", () => {
    expect(keystrokesFor("__x", "__x")).toEqual([]);
  });
});
