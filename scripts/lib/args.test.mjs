import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeDevArgs } from "./args.mjs";

test("a leading -- from pnpm forwarding is stripped, filters detected", () => {
  assert.deepEqual(normalizeDevArgs(["--", "--filter=@onecli/web"]), {
    args: ["--filter=@onecli/web"],
    userFiltered: true,
  });
  assert.deepEqual(normalizeDevArgs(["--filter=@onecli/web"]), {
    args: ["--filter=@onecli/web"],
    userFiltered: true,
  });
  assert.equal(normalizeDevArgs(["-F", "@onecli/web"]).userFiltered, true);
  assert.equal(normalizeDevArgs(["-F=@onecli/web"]).userFiltered, true);
});

test("only ONE leading -- is stripped and plain runs stay untouched", () => {
  assert.deepEqual(normalizeDevArgs([]), { args: [], userFiltered: false });
  // turbo still understands a later `--` as its own task-arg separator.
  assert.deepEqual(normalizeDevArgs(["--", "--", "--port=1"]).args, [
    "--",
    "--port=1",
  ]);
});
