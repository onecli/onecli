import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  createCronSchema,
  updateCronSchema,
  updateTaskArgsSchema,
} from "./crons";

/**
 * The edit doors parse into the service's update type, and the compiler has
 * to see every field: a key that drops out of the parsed type is a field the
 * service can no longer be checked against (it compiles whatever reaches
 * it). These are checked by `tsc` (check-types), not only at runtime.
 */
describe("cron edit schemas", () => {
  it("keep every field typed", () => {
    type Update = z.infer<typeof updateCronSchema>;
    type Task = z.infer<typeof updateTaskArgsSchema>;
    expectTypeOf<Update["gate"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Update["gateDescription"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<Update["schedule"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Update["enabled"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Task["cronId"]>().toEqualTypeOf<string>();
    expectTypeOf<Task["gate"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("read an empty gate as removing it, and an absent one as unchanged", () => {
    expect(updateCronSchema.parse({ gate: "" })).toEqual({ gate: null });
    expect(updateCronSchema.parse({ name: "x" })).toEqual({ name: "x" });
    expect(() => updateCronSchema.parse({ bogus: 1 })).toThrow();
    expect(() =>
      createCronSchema.parse({
        name: "n",
        prompt: "p",
        schedule: "0 9 * * *",
        timezone: "UTC",
        bogus: 1,
      }),
    ).toThrow();
  });
});
