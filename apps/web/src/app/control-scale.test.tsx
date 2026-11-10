// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Select, SelectTrigger } from "@onecli/ui/components/select";

/**
 * One height scale for the form controls in `packages/ui`.
 *
 * The flat restyle moved inputs and buttons from 36/32px to 32/28px but left
 * the select at 36/32px, so every select sharing a row with an input or a
 * button (the Slack member link form, the rule form's rate limit, path and
 * method rows, the SSH key picker) stood 4px taller than its neighbours.
 *
 * Rendered through the real components: each control's height class for
 * its size (a select's comes from its `data-size` variant) must sit on the
 * same step, h-8 (32px) for default and h-7 (28px) for small. Moving one
 * control alone fails here.
 */

/** Tailwind height step the element renders at, e.g. `h-8` -> 8, honouring
 *  a `data-[size=<size>]:h-N` variant when the element carries `data-size`. */
const heightStep = (el: Element): number | null => {
  const classes = el.className.split(/\s+/);
  const size = el.getAttribute("data-size");
  const sized = size
    ? classes.find((c) => c.startsWith(`data-[size=${size}]:h-`))
    : undefined;
  const plain = classes.find((c) => /^h-\d+$/.test(c));
  const pick = sized ?? plain;
  return pick ? Number(pick.slice(pick.lastIndexOf("h-") + 2)) : null;
};

const select = (size?: "default" | "sm") => {
  const { container } = render(
    <Select>
      <SelectTrigger size={size} aria-label="pick" />
    </Select>,
  );
  const trigger = container.querySelector('[data-slot="select-trigger"]');
  if (!trigger) throw new Error("no select trigger rendered");
  return trigger;
};

const one = (ui: React.ReactElement) => {
  const el = render(ui).container.firstElementChild;
  if (!el) throw new Error("nothing rendered");
  return el;
};

describe("form control height scale", () => {
  it("renders the default button, input and select at the same height", () => {
    const steps = [
      heightStep(one(<Button>Save</Button>)),
      heightStep(one(<Input aria-label="name" />)),
      heightStep(select()),
    ];
    expect(steps).toEqual([8, 8, 8]);
  });

  it("renders the small button and select at the same height", () => {
    const steps = [
      heightStep(one(<Button size="sm">Save</Button>)),
      heightStep(select("sm")),
    ];
    expect(steps).toEqual([7, 7]);
  });
});
