import { runHarnessConformance } from "./conformance";
import { createFakeHarness, createFakeSessionStore } from "./fake";

// The proof the interface isn't vendor-shaped (§3.5 rule 4): the fake adapter
// passes the exact suite the real one does, with no Docker and no model key.
// A shared store makes resume meaningful across harness instances.
const store = createFakeSessionStore();

runHarnessConformance({
  name: "fake",
  makeHarness: () => Promise.resolve(createFakeHarness({ store })),
  expectToolUse: true,
});
