/**
 * A sidebar icon's hover loop, as data, and the player that runs it.
 *
 * A loop moves the parts of a Lucide icon (the `<svg>` itself, or one of its
 * child nodes by index) through keyframes on one timeline, and every track
 * starts and ends at the part's rest state: the icon the user sees before
 * the hover is exactly the icon left when the loop ends. Playback is the Web
 * Animations API with `fill: "none"`, so the moment a loop ends the icon is
 * the static Lucide icon again.
 */

/** A point in the icon's 24x24 drawing space. */
export type IconPoint = readonly [x: number, y: number];

/** One keyframe of a track. `at` is the loop's progress, 0 to 1. */
export interface LoopFrame {
  at: number;
  /** Shift, in drawing units. Child parts only: on the `<svg>` itself a
   *  shift would be in CSS pixels, so loops move the svg by turning and
   *  scaling alone (the tests hold every loop to that). */
  translate?: IconPoint;
  /** Turn, in degrees (clockwise). */
  rotate?: number;
  /** Scale, the same on both axes. Never one axis alone: a stretched
   *  stroke thins or thickens, and holding its weight instead
   *  (`vector-effect: non-scaling-stroke`) smears under an animated
   *  transform in Chromium. A line that grows or shrinks is drawn. */
  scale?: number;
  opacity?: number;
  /** The visible stretch of a stroke, as `[from, to]` along its length (0 to
   *  1): `[0, 1]` is the whole stroke, `[t, t]` none of it. */
  draw?: readonly [from: number, to: number];
  /** The easing from this keyframe to the next (a CSS easing). */
  ease?: string;
}

/** A track: the keyframes of one part of the icon. */
export interface LoopTrack {
  /** The `<svg>` itself, or the index of one of its child nodes. */
  part: "svg" | number;
  /** The pivot for turns and scales, in drawing units (default the centre). */
  origin?: IconPoint;
  frames: readonly LoopFrame[];
}

/** An extra node the loop draws into, appended after the Lucide icon's own
 *  (typing dots, a cord, a bubble). Hidden at rest. */
export type LoopExtra = readonly [
  tag: "path" | "circle",
  attrs: Readonly<Record<string, string>>,
];

export interface IconLoop {
  /** One loop, start to end, in milliseconds. */
  duration: number;
  tracks: readonly LoopTrack[];
  extras?: readonly LoopExtra[];
  /**
   * Plays while hovered and runs back on leave, instead of always finishing
   * once started (the gear, as in Resend's sidebar).
   */
  reversible?: true;
  /**
   * The icon's rotational symmetry, in degrees: a turn by a multiple of it
   * lands on the same drawing (the gear's six teeth: 60), so a loop may end
   * turned that far and still end at rest.
   */
  symmetry?: number;
}

/** The icon's drawing space (Lucide draws on a 24x24 grid). */
const VIEWBOX = 24;

/** A dash longer than any icon stroke, for the gap after a drawn stretch. */
const DASH_GAP_PAD = 8;

const px = (v: number) => `${v}px`;

/**
 * The dash pattern that shows `[from, to]` of a stroke `length` long.
 *
 * An empty stretch parks a zero-length dash just past the nearer end of the
 * path: a zero-length dash still paints its round cap, so left on the line
 * it would leave a dot behind. A stretch that reaches the end runs one unit
 * past it, so rounding can never open a hairline gap at the tip.
 */
export const dashFor = (
  [from, to]: readonly [number, number],
  length: number,
): { strokeDasharray: string; strokeDashoffset: string } => {
  const gap = length + DASH_GAP_PAD;
  if (to - from < 1e-4) {
    return {
      strokeDasharray: `0 ${gap}`,
      strokeDashoffset: `${from <= 0.5 ? 3 : -(length + 3)}`,
    };
  }
  return {
    strokeDasharray: `${(to - from) * length + (to >= 1 ? 1 : 0)} ${gap}`,
    strokeDashoffset: `${-from * length}`,
  };
};

/** One frame as a Web Animations keyframe. `length` is the stroke's length,
 *  read only when the track draws; `pivot` is where the track turns and
 *  scales from, held on every frame. */
export const toKeyframe = (
  frame: LoopFrame,
  length: number,
  pivot: Keyframe = {},
): Keyframe => {
  const k: Keyframe = { ...pivot, offset: frame.at };
  if (frame.translate) {
    k.translate = `${px(frame.translate[0])} ${px(frame.translate[1])}`;
  }
  if (frame.rotate !== undefined) k.rotate = `${frame.rotate}deg`;
  if (frame.scale !== undefined) k.scale = `${frame.scale}`;
  if (frame.opacity !== undefined) k.opacity = frame.opacity;
  if (frame.draw) Object.assign(k, dashFor(frame.draw, length));
  if (frame.ease) k.easing = frame.ease;
  return k;
};

const partOf = (svg: SVGSVGElement, part: LoopTrack["part"]) =>
  part === "svg" ? svg : svg.children.item(part);

const isGeometry = (el: Element): el is SVGGeometryElement =>
  "getTotalLength" in el;

/**
 * Where every frame of `track` turns and scales from. Held in the keyframes
 * rather than set, so it is gone the moment the loop ends.
 */
const pivotOf = (track: LoopTrack, onSvg: boolean): Keyframe => {
  const [ox, oy] = track.origin ?? [VIEWBOX / 2, VIEWBOX / 2];
  return onSvg
    ? { transformOrigin: `${(ox / VIEWBOX) * 100}% ${(oy / VIEWBOX) * 100}%` }
    : { transformBox: "view-box", transformOrigin: `${px(ox)} ${px(oy)}` };
};

/**
 * Start `loop` on `svg`: one animation per track, all on the same clock.
 * Returns them so the caller can watch, reverse, or cancel the loop. With
 * `fill: "none"` and the pivot in the keyframes, a loop leaves nothing on
 * the icon once it ends or is cancelled. A track whose part is missing is
 * skipped (a Lucide upgrade that redrew the icon must never throw from a
 * hover); the unit tests pin every part.
 */
export const playLoop = (svg: SVGSVGElement, loop: IconLoop): Animation[] =>
  loop.tracks.flatMap((track) => {
    const el = partOf(svg, track.part);
    if (!(el instanceof SVGElement)) return [];
    const pivot = pivotOf(track, el === svg);
    const draws = track.frames.some((f) => f.draw);
    const length = draws && isGeometry(el) ? el.getTotalLength() : 0;
    return [
      el.animate(
        track.frames.map((f) => toKeyframe(f, length, pivot)),
        { duration: loop.duration, easing: "linear", fill: "none" },
      ),
    ];
  });
