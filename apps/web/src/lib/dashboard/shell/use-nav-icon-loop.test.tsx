// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  Activity,
  Ellipsis,
  MessageSquare,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { navIconLoop } from "./nav-icon-loops";
import {
  HOVER_INTENT_MS,
  REPLAY_FROM,
  REWIND_RATE,
  useNavIconLoop,
} from "./use-nav-icon-loop";
import { NavIconExtras } from "./nav-icon-extras";

/**
 * The hover rules, as Resend's sidebar plays them. jsdom has no Web
 * Animations, so `Element.animate` is a stand-in that records what was
 * asked of it and lets a test set where the loop is.
 */

class FakeAnimation extends EventTarget {
  playState: AnimationPlayState = "running";
  currentTime: number | null = 0;
  playbackRate = 1;
  cancel = vi.fn(() => {
    this.playState = "idle";
    this.dispatchEvent(new Event("cancel"));
  });
  finish = () => {
    this.playState = "finished";
    this.dispatchEvent(new Event("finish"));
  };
  play = vi.fn(() => {
    this.playState = "running";
  });
  updatePlaybackRate = vi.fn((rate: number) => {
    this.playbackRate = rate;
  });
}

let started: FakeAnimation[] = [];
let reduceMotion = false;

beforeEach(() => {
  vi.useFakeTimers();
  started = [];
  reduceMotion = false;
  Element.prototype.animate = vi.fn(() => {
    const a = new FakeAnimation();
    started.push(a);
    return a as unknown as Animation;
  });
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("reduce") && reduceMotion,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

const Row = ({ icon }: { icon: LucideIcon }) => {
  const hover = useNavIconLoop(icon);
  const Icon = icon;
  return (
    <a href="#row" {...hover?.rowProps}>
      <Icon ref={hover?.svgRef} aria-hidden>
        {hover && <NavIconExtras loop={hover.loop} />}
      </Icon>
      row
    </a>
  );
};

const row = () => screen.getByRole("link", { name: "row" });
/** One start of the loop: one animation per track. */
const loopsStarted = (icon: LucideIcon) =>
  started.length / (navIconLoop(icon)?.tracks.length ?? 1);

describe("a row's icon loop", () => {
  it("plays once the pointer rests on the row for the hover intent", () => {
    render(<Row icon={Activity} />);
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS - 1));
    expect(started).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(loopsStarted(Activity)).toBe(1);
  });

  it("plays nothing for a pointer that only passes over", () => {
    render(<Row icon={Activity} />);
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS / 2));
    fireEvent.mouseLeave(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS * 4));
    expect(started).toHaveLength(0);
  });

  it("finishes a started loop after the pointer leaves", () => {
    render(<Row icon={Activity} />);
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    fireEvent.mouseLeave(row());
    for (const a of started) {
      expect(a.cancel).not.toHaveBeenCalled();
      expect(a.updatePlaybackRate).not.toHaveBeenCalled();
    }
  });

  it("does not restart mid-loop, and replays once nearly through", () => {
    render(<Row icon={Activity} />);
    const { duration } = navIconLoop(Activity) ?? { duration: 0 };
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    fireEvent.mouseLeave(row());

    // Halfway: hovering again changes nothing.
    for (const a of started) a.currentTime = duration / 2;
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS * 2));
    expect(loopsStarted(Activity)).toBe(1);
    fireEvent.mouseLeave(row());

    // Nearly through: the next hover plays it again, from the start.
    for (const a of started) a.currentTime = duration * REPLAY_FROM;
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    expect(loopsStarted(Activity)).toBe(2);
  });

  it("plays again once the loop has finished", () => {
    render(<Row icon={Activity} />);
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    fireEvent.mouseLeave(row());
    for (const a of started) a.finish();
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    expect(loopsStarted(Activity)).toBe(2);
  });

  it("plays nothing when reduced motion is asked for", () => {
    reduceMotion = true;
    render(<Row icon={Activity} />);
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS * 4));
    expect(started).toHaveLength(0);
  });

  it("stops a loop in flight when the row goes away", () => {
    const { unmount } = render(<Row icon={Activity} />);
    fireEvent.mouseEnter(row());
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    unmount();
    for (const a of started) expect(a.cancel).toHaveBeenCalled();
  });

  it("draws each icon exactly as Lucide does when it has no extras", () => {
    render(<Row icon={Ellipsis} />);
    expect(row().querySelectorAll("svg > *")).toHaveLength(3);
  });

  it("draws a loop's extra strokes hidden at rest", () => {
    render(<Row icon={MessageSquare} />);
    const nodes = [...row().querySelectorAll("svg > *")];
    // The bubble, then three typing dots nobody sees until the loop.
    expect(nodes).toHaveLength(4);
    for (const dot of nodes.slice(1)) {
      expect(dot.getAttribute("opacity")).toBe("0");
    }
  });
});

describe("the gear (a reversible loop)", () => {
  it("turns from the first moment of the hover, with no intent delay", () => {
    render(<Row icon={Settings} />);
    fireEvent.mouseEnter(row());
    expect(loopsStarted(Settings)).toBe(1);
  });

  it("runs back faster when the pointer leaves, and on again on return", () => {
    render(<Row icon={Settings} />);
    fireEvent.mouseEnter(row());
    fireEvent.mouseLeave(row());
    for (const a of started) {
      expect(a.updatePlaybackRate).toHaveBeenLastCalledWith(-REWIND_RATE);
      expect(a.play).toHaveBeenCalled();
    }
    fireEvent.mouseEnter(row());
    for (const a of started) {
      expect(a.updatePlaybackRate).toHaveBeenLastCalledWith(1);
    }
    // The same loop carries on: never a second start, never a snap.
    expect(loopsStarted(Settings)).toBe(1);
    for (const a of started) expect(a.cancel).not.toHaveBeenCalled();
  });
});
