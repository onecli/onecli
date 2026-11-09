import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
import { getNavItems, workspaceNavItems } from "@/lib/nav-config";
import {
  dashFor,
  toKeyframe,
  type IconLoop,
  type LoopFrame,
} from "./nav-icon-loop";
import { navIconLoop } from "./nav-icon-loops";
import { shellNavRows } from "./shell-nav";

/**
 * The loops are data, so what makes them right is checkable without a
 * browser: each starts and ends at the resting icon, names parts that exist
 * in the Lucide icon it plays on, and is a well-formed timeline.
 */

/** Every icon with a loop, by what its row says. */
const ICONS: readonly (readonly [string, LucideIcon])[] = [
  ["Chat", MessageSquare],
  ["Knowledge", BookOpen],
  ["Apps", Plug],
  ["Contacts", Users],
  ["Schedules", CalendarClock],
  ["More", Ellipsis],
  ["Activity", Activity],
  ["Evals", FlaskConical],
  ["Webhooks", Webhook],
  ["Ports", Globe],
  ["Agent settings", Settings],
  ["Workspaces", FolderOpen],
  ["Channels", MessagesSquare],
  ["Skills", Sparkles],
  ["Groups", Boxes],
  ["Billing", CreditCard],
];

/**
 * Each icon as Lucide 0.562 draws it: the loops move these nodes by index
 * and are tuned to these shapes (the plug's foot at y=17, the globe's lens
 * a 4-wide meridian pair, the gear's six teeth). An upgrade that redraws
 * any of them fails here, so the loop is re-checked rather than left
 * animating a stroke that moved.
 */
const DRAWN: Readonly<Record<string, string>> = {
  Chat: '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"></path>',
  Knowledge:
    '<path d="M12 7v14"></path><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"></path>',
  Apps: '<path d="M12 22v-5"></path><path d="M15 8V2"></path><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"></path><path d="M9 8V2"></path>',
  Contacts:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M16 3.128a4 4 0 0 1 0 7.744"></path><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><circle cx="9" cy="7" r="4"></circle>',
  Schedules:
    '<path d="M16 14v2.2l1.6 1"></path><path d="M16 2v4"></path><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"></path><path d="M3 10h5"></path><path d="M8 2v4"></path><circle cx="16" cy="16" r="6"></circle>',
  More: '<circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle>',
  Activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path>',
  Evals:
    '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path>',
  Webhooks:
    '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"></path><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"></path><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"></path>',
  Ports:
    '<circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path>',
  "Agent settings":
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle>',
  Workspaces:
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path>',
  Channels:
    '<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"></path>',
  Skills:
    '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle>',
  Groups:
    '<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"></path><path d="m7 16.5-4.74-2.85"></path><path d="m7 16.5 5-3"></path><path d="M7 16.5v5.17"></path><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"></path><path d="m17 16.5-5-3"></path><path d="m17 16.5 4.74-2.85"></path><path d="M17 16.5v5.17"></path><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"></path><path d="M12 8 7.26 5.15"></path><path d="m12 8 4.74-2.85"></path><path d="M12 13.5V8"></path>',
  Billing:
    '<rect width="20" height="14" x="2" y="5" rx="2"></rect><line x1="2" x2="22" y1="10" y2="10"></line>',
};

/** What Lucide draws inside the icon's `<svg>`. */
const lucideInner = (icon: LucideIcon): string =>
  renderToStaticMarkup(createElement(icon)).replace(
    /^<svg[^>]*>|<\/svg>$/g,
    "",
  );

/** The icon's nodes, in order (their tag names). */
const lucideNodes = (icon: LucideIcon): string[] =>
  [...lucideInner(icon).matchAll(/<([a-z]+)\b/g)].map((m) => m[1] ?? "");

const loopFor = (icon: LucideIcon): IconLoop => {
  const loop = navIconLoop(icon);
  if (!loop) throw new Error("no loop");
  return loop;
};

/** What a part looks like at a frame, with every unset property at rest. */
const lookAt = (frame: LoopFrame) => ({
  translate: frame.translate ?? [0, 0],
  rotate: frame.rotate ?? 0,
  scale: frame.scale ?? 1,
  opacity: frame.opacity,
  draw: frame.draw ?? [0, 1],
});

describe("every sidebar row's icon", () => {
  it("has its own loop, in an agent and outside one", () => {
    const hosted = shellNavRows({
      workspaceId: "ws1",
      agent: { id: "ag1", kind: "hosted" },
    });
    // The org's rows with every optional one shown (Groups, Channels,
    // Skills; Billing on a cloud build), and a workspace's own.
    const scope = [
      ...getNavItems("org1", { entitled: true, hosted: true }).flat(),
      ...workspaceNavItems("ws1"),
    ];
    const icons = new Set([
      ...hosted.map((row) => row.icon),
      ...scope.map((item) => item.icon),
      Ellipsis,
      // Cloud-only, so not in this lane's org rows.
      CreditCard,
    ]);
    for (const icon of icons) expect(navIconLoop(icon)).toBeDefined();
    // And no loop for an icon no row shows.
    expect(new Set(ICONS.map(([, icon]) => icon))).toEqual(icons);
    // Distinct loops: no two icons share one.
    const loops = ICONS.map(([, icon]) => loopFor(icon));
    expect(new Set(loops).size).toBe(loops.length);
  });

  it("runs a Resend-length loop, one to two seconds", () => {
    for (const [, icon] of ICONS) {
      const { duration } = loopFor(icon);
      expect(duration).toBeGreaterThanOrEqual(1000);
      expect(duration).toBeLessThanOrEqual(2000);
    }
  });
});

describe.each(ICONS)("%s's loop", (name, icon) => {
  const loop = loopFor(icon);
  const node = lucideNodes(icon);
  const parts = node.length + (loop.extras?.length ?? 0);

  it("plays on the icon it was drawn for", () => {
    expect(lucideInner(icon)).toBe(DRAWN[name]);
  });

  it("moves only parts the Lucide icon has", () => {
    // A Lucide upgrade that adds or drops a node fails here, not on screen.
    for (const track of loop.tracks) {
      if (track.part === "svg") continue;
      expect(track.part).toBeGreaterThanOrEqual(0);
      expect(track.part).toBeLessThan(parts);
    }
  });

  it("is a well-formed timeline: 0 to 1, never going back", () => {
    for (const track of loop.tracks) {
      const offsets = track.frames.map((f) => f.at);
      expect(offsets[0]).toBe(0);
      expect(offsets.at(-1)).toBe(1);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? 0);
      }
    }
  });

  it("starts and ends on the resting icon", () => {
    for (const track of loop.tracks) {
      const first = track.frames[0];
      const last = track.frames.at(-1);
      if (!first || !last) throw new Error("empty track");
      const isExtra =
        typeof track.part === "number" && track.part >= node.length;
      for (const frame of [first, last]) {
        const look = lookAt(frame);
        if (isExtra) {
          // An extra stroke is hidden at rest, wherever it is.
          expect(look.opacity).toBe(0);
          continue;
        }
        expect(look.translate).toEqual([0, 0]);
        expect(look.scale).toBe(1);
        expect(look.opacity ?? 1).toBe(1);
        expect(look.draw).toEqual([0, 1]);
        // A turn lands on rest when it is a whole multiple of the icon's
        // symmetry (360 for any icon, 60 for the six-toothed gear).
        const step = loop.symmetry ?? 360;
        expect(Math.abs(look.rotate % step)).toBeCloseTo(0, 6);
      }
    }
  });

  it("gives the same pose at both ends (nothing jumps on replay)", () => {
    for (const track of loop.tracks) {
      const first = track.frames[0];
      const last = track.frames.at(-1);
      if (!first || !last) throw new Error("empty track");
      const a = lookAt(first);
      const b = lookAt(last);
      expect(b.translate).toEqual(a.translate);
      expect(b.opacity).toBe(a.opacity);
      expect(b.draw).toEqual(a.draw);
    }
  });

  // A shift on the `<svg>` itself would be in CSS pixels, not drawing
  // units: the svg only turns and scales, its parts are what move.
  it("moves the svg only by turning and scaling", () => {
    for (const track of loop.tracks) {
      if (track.part !== "svg") continue;
      for (const frame of track.frames) {
        expect(frame.translate).toBeUndefined();
      }
    }
  });
});

describe("the gear", () => {
  it("is the one loop that runs back on leave, as in Resend's sidebar", () => {
    const reversible = ICONS.filter(([, icon]) => loopFor(icon).reversible);
    expect(reversible.map(([name]) => name)).toEqual(["Agent settings"]);
  });
});

describe("dashFor", () => {
  it("shows the whole stroke, running past the tip", () => {
    expect(dashFor([0, 1], 20)).toEqual({
      strokeDasharray: "21 28",
      strokeDashoffset: "0",
    });
  });

  it("shows a stretch from its start", () => {
    expect(dashFor([0.25, 0.75], 20)).toEqual({
      strokeDasharray: "10 28",
      strokeDashoffset: "-5",
    });
  });

  it("parks an empty stroke off the line, so its round cap leaves no dot", () => {
    expect(dashFor([0, 0], 20).strokeDashoffset).toBe("3");
    expect(dashFor([1, 1], 20).strokeDashoffset).toBe("-23");
    expect(dashFor([1, 1], 20).strokeDasharray).toBe("0 28");
  });
});

describe("toKeyframe", () => {
  it("writes each property the frame sets, and only those", () => {
    expect(
      toKeyframe(
        {
          at: 0.5,
          translate: [1, -2],
          rotate: 30,
          scale: 0.5,
          opacity: 0.4,
          ease: "linear",
        },
        0,
      ),
    ).toEqual({
      offset: 0.5,
      translate: "1px -2px",
      rotate: "30deg",
      scale: "0.5",
      opacity: 0.4,
      easing: "linear",
    });
    expect(toKeyframe({ at: 0, scale: 0.9 }, 0)).toEqual({
      offset: 0,
      scale: "0.9",
    });
  });

  it("carries the track's held properties on every frame", () => {
    expect(toKeyframe({ at: 1 }, 0, { transformOrigin: "50% 50%" })).toEqual({
      offset: 1,
      transformOrigin: "50% 50%",
    });
  });
});
