import { createInProcessEventBus, type EventBus } from "../services/event-bus";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud injects a Redis pub/sub bus (by `ensureEditionDefaults()`
// — the ioredis-backed module must never enter a client bundle, so it is not
// imported here) so a publish on one api pod reaches an SSE stream held on
// another; onprem — one api instance — uses the in-process emitter.
// `initEventBus` remains as a test seam (null resets to the edition default).
//
// The onprem default is a MEMOIZED singleton, not `() => createInProcessEventBus()`:
// the slot resolves a thunk on EVERY `get()` (edition-state.ts), so a
// fresh-per-call bus would give the SSE `subscribe` and the runner `publish`
// different in-process Maps — fan-out would silently deliver to no one. The
// thunk form (over a plain value) keeps creation lazy so nothing is built in a
// client graph that never reads the bus.
let inProcess: EventBus | undefined;
const slot = createEditionSlot<EventBus>(
  "event-bus",
  () => (inProcess ??= createInProcessEventBus()),
);

export const initEventBus = (bus: EventBus | null) => slot.init(bus);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultEventBus = (bus: EventBus) => slot.setCloudDefault(bus);

export const getEventBus = (): EventBus => slot.get();
