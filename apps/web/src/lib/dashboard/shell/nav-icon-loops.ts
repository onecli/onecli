import {
  Activity,
  BookOpen,
  Boxes,
  CalendarClock,
  CreditCard,
  Ellipsis,
  FlaskConical,
  FolderOpen,
  Globe,
  MessageSquare,
  MessagesSquare,
  Plug,
  Settings,
  Sparkles,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { IconLoop, LoopFrame, LoopTrack } from "./nav-icon-loop";

/**
 * Each sidebar row's hover loop, one per icon, after Resend's sidebar: every
 * icon does its own thing, and every loop starts and ends at the resting
 * icon. Authored in frames at 30fps, the rate of Resend's Lottie loops, so
 * the timings read as frame numbers. Part indices are the icon's Lucide
 * nodes in order (lucide-react 0.562), then the loop's `extras`;
 * `nav-icon-loops.test.ts` pins both, so an icon redrawn by a Lucide
 * upgrade fails a test instead of animating the wrong stroke.
 */

/** The curves. The first five are read off Resend's own keyframes; the
 *  rest are ours, in the same family. */
const EASE = {
  /** A squash going in: slow to leave, slow to land. */
  squashIn: "cubic-bezier(0.67, 0, 0.67, 1)",
  /** The squash settling back: a long, soft landing. */
  settle: "cubic-bezier(0.17, 0, 0.5, 1)",
  /** The gear's half turn. */
  turn: "cubic-bezier(0.67, 0, 0.32, 1)",
  gearSquashIn: "cubic-bezier(0.33, 0, 0.67, 1)",
  gearSquashOut: "cubic-bezier(0.33, 0, 0.3, 1)",
  inOut: "cubic-bezier(0.45, 0, 0.55, 1)",
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  in: "cubic-bezier(0.55, 0, 1, 0.45)",
  /** A pop with a little overshoot. */
  pop: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  /** A push: gathers, then drives through. */
  thrust: "cubic-bezier(0.5, 0, 0.2, 1)",
};

const FPS = 30;

/** A loop `frames` long: its duration, and frame number to progress. */
const timeline = (frames: number) => ({
  duration: Math.round((frames / FPS) * 1000),
  at: (frame: number) => Math.round((frame / frames) * 1e4) / 1e4,
});

/** The whole icon dipping and settling back from `origin`: down by frame
 *  `down`, back by `back`, starting at frame `from`. */
const squash = (
  at: (frame: number) => number,
  [down, back]: readonly [number, number],
  depth: number,
  origin?: readonly [number, number],
  from = 0,
): LoopTrack => ({
  part: "svg",
  ...(origin && { origin }),
  frames: [
    ...(from > 0 ? [{ at: 0, scale: 1 }] : []),
    { at: at(from), scale: 1, ease: EASE.squashIn },
    { at: at(down), scale: depth, ease: EASE.settle },
    { at: at(back), scale: 1 },
    { at: 1, scale: 1 },
  ],
});

/** A part pressed in and let back out, from `origin`: the twinkle of a
 *  star, a bubble taking its turn to speak. `pop` is how far past rest it
 *  springs on the way back (1 for none). */
const pulse = (
  part: number,
  origin: readonly [number, number],
  at: (frame: number) => number,
  [start, low, high, end]: readonly [number, number, number, number],
  depth: number,
  pop = 1,
): LoopTrack => ({
  part,
  origin,
  frames: [
    { at: 0, scale: 1 },
    { at: at(start), scale: 1, ease: EASE.squashIn },
    { at: at(low), scale: depth, ease: EASE.out },
    { at: at(high), scale: pop, ease: EASE.inOut },
    { at: at(end), scale: 1 },
    { at: 1, scale: 1 },
  ],
});

/** Chat: a small squash from the tail, then typing dots pop in one by one,
 *  breathe, and pop out. */
const chat = (() => {
  const { duration, at } = timeline(42);
  const dot = (i: number): LoopTrack => {
    const s = 4 + i * 3;
    return {
      part: 1 + i,
      origin: [8 + i * 4, 11],
      frames: [
        { at: 0, scale: 0, opacity: 0 },
        { at: at(s), scale: 0, opacity: 0, ease: EASE.pop },
        { at: at(s + 6), scale: 1, opacity: 1, ease: EASE.inOut },
        { at: at(s + 12), scale: 1, opacity: 0.35, ease: EASE.inOut },
        { at: at(s + 18), scale: 1, opacity: 1, ease: EASE.in },
        { at: at(s + 24), scale: 0, opacity: 0 },
        { at: 1, scale: 0, opacity: 0 },
      ],
    };
  };
  return {
    duration,
    extras: [
      ["path", { d: "M8 11h.01", opacity: "0" }],
      ["path", { d: "M12 11h.01", opacity: "0" }],
      ["path", { d: "M16 11h.01", opacity: "0" }],
    ],
    tracks: [squash(at, [6, 22], 0.92, [2, 22]), dot(0), dot(1), dot(2)],
  } satisfies IconLoop;
})();

/**
 * Knowledge: the book dips, and its spine wipes away and draws back down
 * from the top, like a bookmark slipping in.
 */
const knowledge = (() => {
  const { duration, at } = timeline(45);
  return {
    duration,
    tracks: [
      squash(at, [6, 24], 0.94, [12, 21]),
      {
        part: 0,
        frames: [
          { at: 0, draw: [0, 1] },
          { at: at(3), draw: [0, 1], ease: EASE.in },
          { at: at(11), draw: [1, 1] },
          { at: at(11), draw: [0, 0], ease: EASE.out },
          { at: at(26), draw: [0, 1] },
          { at: 1, draw: [0, 1] },
        ],
      },
    ],
  } satisfies IconLoop;
})();

/** Apps: the plug draws back, pushes in, and eases out again; its cord pays
 *  out and reels in with it, a drawn stretch of a longer twin so its weight
 *  never changes. */
const apps = (() => {
  const { duration, at } = timeline(42);
  // [frame, the plug's drop in drawing units (up is negative), ease onward]
  const keys: readonly (readonly [number, number, string?])[] = [
    [0, 0, EASE.inOut],
    [7, 1.2, EASE.thrust],
    [13, -2.4],
    [17, -2.4, EASE.out],
    [36, 0],
  ];
  const plug = (part: number): LoopTrack => ({
    part,
    frames: [
      ...keys.map(
        ([frame, drop, ease]): LoopFrame => ({
          at: at(frame),
          translate: [0, drop],
          ...(ease && { ease }),
        }),
      ),
      { at: 1, translate: [0, 0] },
    ],
  });
  // The twin runs from y=22 up to y=12; the cord reaches the plug's foot,
  // at y=17 plus the drop, so it shows (5 - drop) of its 10.
  const reach = (drop: number): readonly [number, number] => [
    0,
    (5 - drop) / 10,
  ];
  // Lucide's own cord shows at rest; its twin takes over for the motion.
  const lucide: LoopTrack = {
    part: 0,
    frames: [
      { at: 0, opacity: 1 },
      { at: at(0.5), opacity: 1 },
      { at: at(0.5), opacity: 0 },
      { at: at(36), opacity: 0 },
      { at: at(36), opacity: 1 },
      { at: 1, opacity: 1 },
    ],
  };
  const twin: LoopTrack = {
    part: 4,
    frames: [
      { at: 0, opacity: 0, draw: reach(0) },
      { at: at(0.5), opacity: 0, draw: reach(0) },
      ...keys.map(
        ([frame, drop, ease]): LoopFrame => ({
          at: at(Math.max(frame, 0.5)),
          opacity: 1,
          draw: reach(drop),
          ...(ease && { ease }),
        }),
      ),
      { at: at(36), opacity: 0, draw: reach(0) },
      { at: 1, opacity: 0, draw: reach(0) },
    ],
  };
  return {
    duration,
    extras: [["path", { d: "M12 22V12", opacity: "0" }]],
    tracks: [plug(1), plug(2), plug(3), lucide, twin],
  } satisfies IconLoop;
})();

/** Contacts: a squash; the person behind slips out and back in from the
 *  other side while the one in front nods. */
const contacts = (() => {
  const { duration, at } = timeline(48);
  const behind = (part: number): LoopTrack => ({
    part,
    frames: [
      { at: 0, translate: [0, 0], opacity: 1 },
      { at: at(3), translate: [0, 0], opacity: 1, ease: EASE.in },
      { at: at(13), translate: [-3, 0], opacity: 0 },
      { at: at(13), translate: [3, 0], opacity: 0, ease: EASE.out },
      { at: at(32), translate: [0, 0], opacity: 1 },
      { at: 1, translate: [0, 0], opacity: 1 },
    ],
  });
  return {
    duration,
    tracks: [
      squash(at, [12, 30], 0.9, [12, 22]),
      behind(1),
      behind(2),
      {
        part: 3,
        frames: [
          { at: 0, translate: [0, 0] },
          { at: at(8), translate: [0, 0], ease: EASE.out },
          { at: at(16), translate: [0, -1.4], ease: EASE.inOut },
          { at: at(28), translate: [0, 0] },
          { at: 1, translate: [0, 0] },
        ],
      },
    ],
  } satisfies IconLoop;
})();

/** Schedules: the clock's hands sweep one full turn while the calendar's
 *  rings hop, like an alarm. */
const schedules = (() => {
  const { duration, at } = timeline(48);
  const ring = (part: number, start: number): LoopTrack => ({
    part,
    frames: [
      { at: 0, translate: [0, 0] },
      { at: at(start), translate: [0, 0], ease: EASE.out },
      { at: at(start + 5), translate: [0, -1], ease: EASE.inOut },
      { at: at(start + 12), translate: [0, 0] },
      { at: 1, translate: [0, 0] },
    ],
  });
  return {
    duration,
    tracks: [
      squash(at, [6, 22], 0.94, [12, 22]),
      {
        part: 0,
        origin: [16, 16],
        frames: [
          { at: 0, rotate: 0 },
          { at: at(2), rotate: 0, ease: EASE.turn },
          { at: at(38), rotate: 360 },
          { at: 1, rotate: 360 },
        ],
      },
      ring(4, 3),
      ring(1, 6),
    ],
  } satisfies IconLoop;
})();

/** More: the three dots hop in a wave, left to right. */
const more = (() => {
  const { duration, at } = timeline(36);
  const hop = (part: number, start: number): LoopTrack => ({
    part,
    frames: [
      { at: 0, translate: [0, 0] },
      { at: at(start), translate: [0, 0], ease: EASE.out },
      { at: at(start + 6), translate: [0, -3], ease: EASE.in },
      { at: at(start + 12), translate: [0, 0], ease: EASE.out },
      { at: at(start + 16), translate: [0, -0.6], ease: EASE.in },
      { at: at(start + 19), translate: [0, 0] },
      { at: 1, translate: [0, 0] },
    ],
  });
  // Lucide's dots are drawn centre, right, left.
  return {
    duration,
    tracks: [hop(2, 2), hop(0, 5), hop(1, 8)],
  } satisfies IconLoop;
})();

/**
 * Activity: a monitor's sweep. The trace wipes away from the left at an
 * even pace (an ease-in would race through the tall spike and read as a
 * snap), then redraws from the left after a beat. Lucide draws the line
 * from the right, so the wipe moves the dash's far end and the redraw its
 * start; the last stub fades rather than popping its round cap.
 */
const activity = (() => {
  const { duration, at } = timeline(42);
  return {
    duration,
    tracks: [
      {
        part: 0,
        frames: [
          { at: 0, draw: [0, 1], opacity: 1 },
          { at: at(2), draw: [0, 1], opacity: 1, ease: EASE.inOut },
          { at: at(13), draw: [0, 0.06], opacity: 1, ease: "linear" },
          { at: at(15), draw: [0, 0], opacity: 0 },
          { at: at(15), draw: [1, 1], opacity: 0, ease: EASE.out },
          { at: at(17), draw: [0.94, 1], opacity: 1, ease: EASE.out },
          { at: at(37), draw: [0, 1], opacity: 1 },
          { at: 1, draw: [0, 1], opacity: 1 },
        ],
      },
    ],
  } satisfies IconLoop;
})();

/** Evals: the flask rocks and settles, its liquid sloshes against it, and
 *  two bubbles rise. */
const evals = (() => {
  const { duration, at } = timeline(50);
  const bubble = (
    part: number,
    start: number,
    from: readonly [number, number],
    rise: number,
  ): LoopTrack => ({
    part,
    origin: from,
    frames: [
      { at: 0, translate: [0, 0], scale: 0, opacity: 0 },
      {
        at: at(start),
        translate: [0, 0],
        scale: 0,
        opacity: 0,
        ease: EASE.pop,
      },
      {
        at: at(start + 5),
        translate: [0, -2],
        scale: 1,
        opacity: 1,
        ease: "linear",
      },
      {
        at: at(start + 16),
        translate: [0, -rise],
        scale: 1,
        opacity: 1,
        ease: EASE.in,
      },
      {
        at: at(start + 22),
        translate: [0, -rise - 2.5],
        scale: 0.4,
        opacity: 0,
      },
      // Gone, it drops back home unseen, so a replay starts where it ends.
      { at: at(start + 23), translate: [0, 0], scale: 0, opacity: 0 },
      { at: 1, translate: [0, 0], scale: 0, opacity: 0 },
    ],
  });
  const rock = (
    part: LoopTrack["part"],
    origin: readonly [number, number],
    keys: readonly (readonly [number, number])[],
  ): LoopTrack => ({
    part,
    origin,
    frames: [
      { at: 0, rotate: 0, ease: EASE.inOut },
      ...keys.map(
        ([frame, deg]): LoopFrame => ({
          at: at(frame),
          rotate: deg,
          ease: EASE.inOut,
        }),
      ),
      { at: 1, rotate: 0 },
    ],
  });
  return {
    duration,
    extras: [
      ["path", { d: "M10.6 18.6h.01", opacity: "0" }],
      ["path", { d: "M13.4 19.2h.01", opacity: "0" }],
    ],
    tracks: [
      rock(
        "svg",
        [12, 22],
        [
          [9, -8],
          [19, 5],
          [28, -2],
          [38, 0],
        ],
      ),
      rock(
        1,
        [12, 15],
        [
          [11, 7],
          [21, -5],
          [31, 2],
          [41, 0],
        ],
      ),
      bubble(3, 8, [10.6, 18.6], 6),
      bubble(4, 14, [13.4, 19.2], 7),
    ],
  } satisfies IconLoop;
})();

/** Webhooks: the hook squeezes and turns a little while a signal runs round
 *  it: each arm unwinds into its loop and winds back out, one after
 *  another, so at most one arm is ever away. */
const webhooks = (() => {
  const { duration, at } = timeline(48);
  const arm = (part: number, start: number): LoopTrack => ({
    part,
    frames: [
      { at: 0, draw: [0, 1] },
      { at: at(start), draw: [0, 1], ease: EASE.in },
      { at: at(start + 8), draw: [1, 1] },
      { at: at(start + 8), draw: [0, 0], ease: EASE.out },
      { at: at(start + 20), draw: [0, 1] },
      { at: 1, draw: [0, 1] },
    ],
  });
  return {
    duration,
    tracks: [
      {
        part: "svg",
        frames: [
          { at: 0, scale: 1, rotate: 0, ease: EASE.squashIn },
          { at: at(10), scale: 0.92, rotate: -10, ease: EASE.settle },
          { at: at(36), scale: 1, rotate: 0 },
          { at: 1, scale: 1, rotate: 0 },
        ],
      },
      arm(1, 2),
      arm(2, 9),
      arm(0, 16),
    ],
  } satisfies IconLoop;
})();

/**
 * Ports: the globe dips and rocks on its axis while its meridians wind out
 * and back in, and the equator sweeps across after them, a signal going
 * round the world.
 */
const ports = (() => {
  const { duration, at } = timeline(54);
  return {
    duration,
    tracks: [
      {
        part: "svg",
        frames: [
          { at: 0, scale: 1, rotate: 0, ease: EASE.squashIn },
          { at: at(8), scale: 0.92, rotate: -14, ease: EASE.settle },
          { at: at(30), scale: 1, rotate: 4, ease: EASE.inOut },
          { at: at(42), scale: 1, rotate: 0 },
          { at: 1, scale: 1, rotate: 0 },
        ],
      },
      {
        part: 1,
        frames: [
          { at: 0, draw: [0, 1] },
          { at: at(3), draw: [0, 1], ease: EASE.in },
          { at: at(13), draw: [1, 1] },
          { at: at(13), draw: [0, 0], ease: EASE.out },
          { at: at(33), draw: [0, 1] },
          { at: 1, draw: [0, 1] },
        ],
      },
      {
        part: 2,
        frames: [
          { at: 0, draw: [0, 1] },
          { at: at(9), draw: [0, 1], ease: EASE.in },
          { at: at(17), draw: [1, 1] },
          { at: at(17), draw: [0, 0], ease: EASE.out },
          { at: at(34), draw: [0, 1] },
          { at: 1, draw: [0, 1] },
        ],
      },
    ],
  } satisfies IconLoop;
})();

/**
 * Agent settings: Resend's Settings, frame for frame. The gear dips and
 * turns half a turn (six teeth: it lands on the same gear), and it is the
 * one reversible loop: it turns while hovered, from the first moment, and
 * runs back when the pointer leaves.
 */
const settings = (() => {
  const { duration, at } = timeline(36);
  return {
    duration,
    reversible: true,
    symmetry: 60,
    tracks: [
      {
        part: "svg",
        frames: [
          { at: 0, rotate: 0, ease: EASE.turn },
          { at: at(31), rotate: -180 },
          { at: 1, rotate: -180 },
        ],
      },
      {
        part: "svg",
        frames: [
          { at: 0, scale: 1, ease: EASE.gearSquashIn },
          { at: at(14), scale: 0.9, ease: EASE.gearSquashOut },
          { at: at(28), scale: 1 },
          { at: 1, scale: 1 },
        ],
      },
    ],
  } satisfies IconLoop;
})();

/** Workspaces: a sheet drops in from above and is gone as it reaches the
 *  folder, and the folder takes its weight with a soft squash from the
 *  bottom. */
const workspaces = (() => {
  const { duration, at } = timeline(45);
  return {
    duration,
    // A sheet at the folder's top edge, hidden at rest. It only shows above
    // the folder (the icon has no fill to hide it behind), so it fades out
    // before it would cross the folder's line.
    extras: [["path", { d: "M10.5 3h6", opacity: "0" }]],
    tracks: [
      {
        part: 1,
        frames: [
          { at: 0, translate: [0, -4], opacity: 0 },
          { at: at(2), translate: [0, -4], opacity: 0, ease: EASE.out },
          { at: at(7), translate: [0, -2.4], opacity: 1, ease: EASE.in },
          { at: at(13), translate: [0, -0.3], opacity: 0 },
          // Gone, it goes back up unseen, so a replay starts where it ends.
          { at: at(14), translate: [0, -4], opacity: 0 },
          { at: 1, translate: [0, -4], opacity: 0 },
        ],
      },
      squash(at, [18, 36], 0.9, [12, 20], 12),
    ],
  } satisfies IconLoop;
})();

/** Channels: the two bubbles take turns, one speaks and the other
 *  answers, each pressed in from its own tail. */
const channels = (() => {
  const { duration, at } = timeline(42);
  return {
    duration,
    tracks: [
      pulse(0, [3, 14], at, [2, 8, 16, 22], 0.84, 1.04),
      pulse(1, [21, 20], at, [13, 19, 27, 33], 0.84, 1.04),
    ],
  } satisfies IconLoop;
})();

/** Skills: the big sparkle twists and twinkles, then the small cross and
 *  the dot twinkle after it, one by one. */
const skills = (() => {
  const { duration, at } = timeline(45);
  const twinkle = (
    part: number,
    origin: readonly [number, number],
    start: number,
  ): LoopTrack => ({
    part,
    origin,
    frames: [
      { at: 0, scale: 1 },
      { at: at(start), scale: 1, ease: EASE.in },
      { at: at(start + 5), scale: 0.2, ease: EASE.pop },
      { at: at(start + 13), scale: 1 },
      { at: 1, scale: 1 },
    ],
  });
  return {
    duration,
    tracks: [
      {
        part: 0,
        frames: [
          { at: 0, scale: 1, rotate: 0, ease: EASE.squashIn },
          { at: at(7), scale: 0.78, rotate: -24, ease: EASE.settle },
          { at: at(26), scale: 1, rotate: 0 },
          { at: 1, scale: 1, rotate: 0 },
        ],
      },
      twinkle(1, [20, 4], 8),
      twinkle(2, [20, 4], 8),
      twinkle(3, [4, 20], 15),
    ],
  } satisfies IconLoop;
})();

/** Groups: the top box lifts off the stack and is set back down, and the
 *  boxes under it take the weight. */
const groups = (() => {
  const { duration, at } = timeline(48);
  const top = (part: number): LoopTrack => ({
    part,
    frames: [
      { at: 0, translate: [0, 0] },
      { at: at(2), translate: [0, 0], ease: EASE.out },
      { at: at(11), translate: [0, -3], ease: EASE.inOut },
      { at: at(15), translate: [0, -3], ease: EASE.in },
      { at: at(21), translate: [0, 0], ease: EASE.out },
      { at: at(25), translate: [0, -0.5], ease: EASE.in },
      { at: at(28), translate: [0, 0] },
      { at: 1, translate: [0, 0] },
    ],
  });
  return {
    duration,
    // Lucide draws the top box last: its outline, then its three edges.
    tracks: [
      top(8),
      top(9),
      top(10),
      top(11),
      squash(at, [24, 40], 0.93, [12, 22], 20),
    ],
  } satisfies IconLoop;
})();

/** Billing: the card is swiped, a pull back and a push through with a
 *  tilt, and its stripe reads across from the left as it goes. */
const billing = (() => {
  const { duration, at } = timeline(45);
  const swipe = (part: number): LoopTrack => ({
    part,
    frames: [
      { at: 0, translate: [0, 0] },
      { at: at(2), translate: [0, 0], ease: EASE.inOut },
      { at: at(8), translate: [-1.5, 0], ease: EASE.thrust },
      { at: at(16), translate: [2, 0], ease: EASE.out },
      { at: at(34), translate: [0, 0] },
      { at: 1, translate: [0, 0] },
    ],
  });
  return {
    duration,
    tracks: [
      {
        part: "svg",
        frames: [
          { at: 0, rotate: 0, ease: EASE.inOut },
          { at: at(8), rotate: 6, ease: EASE.thrust },
          { at: at(16), rotate: -8, ease: EASE.settle },
          { at: at(36), rotate: 0 },
          { at: 1, rotate: 0 },
        ],
      },
      swipe(0),
      swipe(1),
      {
        part: 1,
        frames: [
          { at: 0, draw: [0, 1] },
          { at: at(6), draw: [0, 1], ease: EASE.in },
          { at: at(13), draw: [1, 1] },
          { at: at(13), draw: [0, 0], ease: EASE.out },
          { at: at(30), draw: [0, 1] },
          { at: 1, draw: [0, 1] },
        ],
      },
    ],
  } satisfies IconLoop;
})();

/** Every icon with a loop. Keyed by the Lucide component itself, so a row
 *  that changes its icon loses the loop rather than playing a wrong one.
 *  The agent's rows first, then the org's and workspace's own. */
const LOOPS: ReadonlyMap<LucideIcon, IconLoop> = new Map<LucideIcon, IconLoop>([
  [MessageSquare, chat],
  [BookOpen, knowledge],
  [Plug, apps],
  [Users, contacts],
  [CalendarClock, schedules],
  [Ellipsis, more],
  [Activity, activity],
  [FlaskConical, evals],
  [Webhook, webhooks],
  [Globe, ports],
  [Settings, settings],
  [FolderOpen, workspaces],
  [MessagesSquare, channels],
  [Sparkles, skills],
  [Boxes, groups],
  [CreditCard, billing],
]);

/** The hover loop for a sidebar icon, if it has one. */
export const navIconLoop = (icon: LucideIcon): IconLoop | undefined =>
  LOOPS.get(icon);
