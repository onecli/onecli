import { IS_CLOUD } from "../lib/env";

/**
 * The shared machinery behind every provider seam ("edition slot"), plus the
 * flag tracking whether `ensureEditionDefaults()` (package root) has run.
 * Providers whose CLOUD implementation is injected by it fail loudly when read
 * on cloud before it runs — a silent fall-through to the onprem default would
 * mean quotas, RBAC, or KMS quietly off on the hosted platform.
 *
 * Lives in its own module (not `edition-defaults.ts`) so provider files can
 * import it without creating a cycle with the defaults module that imports
 * every provider.
 *
 * The state lives on `globalThis`, NOT in module scope (same pattern as
 * `@onecli/db`'s Prisma singleton, and for the same reason): Next.js dev
 * evaluates route graphs in isolated module registries, so a module-scoped
 * slot exists once PER GRAPH — an injection performed by one render (or by
 * instrumentation) was invisible to a render whose graph re-instantiated
 * this module, and on an entitled self-host the empty role-resolver slot
 * silently denied a workspace's own owner. `globalThis` is per PROCESS, which
 * is the scope injection actually means. Tests keep module-scoped state
 * (vitest isolates module registries per file but shares the worker's
 * globalThis — sharing would leak one file's `init*` overrides into the
 * next).
 */
interface SlotState {
  override: unknown;
  overridden: boolean;
  cloudDefault: { value: unknown } | null;
}

interface EditionStore {
  applied: boolean;
  slots: Map<string, SlotState>;
}

const globalForEditionSlots = globalThis as unknown as {
  __onecliEditionSlots?: EditionStore;
};

const store: EditionStore =
  process.env.NODE_ENV === "test"
    ? { applied: false, slots: new Map() }
    : (globalForEditionSlots.__onecliEditionSlots ??= {
        applied: false,
        slots: new Map(),
      });

export const markEditionDefaultsApplied = (): void => {
  store.applied = true;
};

/**
 * Throw for a read of an edition default that was never injected. The message
 * distinguishes "ensureEditionDefaults() never ran" (a host wiring bug) from
 * "ran but skipped this provider" (a missing injector in edition-defaults.ts).
 */
export const failMissingCloudDefault = (provider: string): never => {
  throw new Error(
    store.applied
      ? `${provider}: ensureEditionDefaults() ran but did not inject this ` +
          "provider's default — add its setDefault call to edition-defaults.ts."
      : `${provider}: the edition default has not been injected — ` +
          "ensureEditionDefaults() must run at process start (createApiApp and " +
          "the web server init both call it).",
  );
};

/** One provider seam. See `createEditionSlot`. */
export interface EditionSlot<T> {
  /**
   * Override the resolved value (host options / tests). `null` resets to the
   * edition default — uniform across every slot.
   */
  init: (v: T | null) => void;
  /** Package-internal: the `ensureEditionDefaults()` injector. */
  setCloudDefault: (v: T) => void;
  get: () => T;
}

/**
 * The uniform edition-slot semantics every provider seam shares:
 *
 * - an explicit override (`init`) always wins; `init(null)` resets;
 * - otherwise CLOUD resolves the injected cloud default and FAILS LOUDLY when
 *   `ensureEditionDefaults()` hasn't provided it (see above);
 * - otherwise (onprem) resolves `onpremDefault`.
 *
 * `onpremDefault` may be a thunk, resolved on every `get` — use one for a
 * default imported from another module, so the binding is read at CALL time
 * and an import cycle can never hit a TDZ. Thunks are detected with
 * `typeof === "function"`, so a slot whose T is ITSELF a function type must
 * always use the thunk form (today none needs to — the only function-typed
 * slot, sessionEnforcer, defaults to null).
 *
 * The seams NOT built on this factory are `newOrgPolicySeeder` and
 * `attachmentStore`, whose onprem arms are also injected (every edition impl
 * rides the DB client, which must not reach a browser bundle) — they fail
 * loudly in BOTH editions instead of resolving a static onprem default.
 */
export const createEditionSlot = <T>(
  name: string,
  onpremDefault: T | (() => T),
): EditionSlot<T> => {
  // Fetch-or-create by NAME from the process-wide store: two module-graph
  // instantiations of the same slot must share one state (see the header).
  // Boxed cloudDefault so an injected value of `null`/`undefined` (for
  // nullable T) could never read as "not injected".
  let state = store.slots.get(name);
  if (!state) {
    state = { override: null, overridden: false, cloudDefault: null };
    store.slots.set(name, state);
  }
  const slotState = state;

  return {
    init: (v) => {
      slotState.override = v;
      slotState.overridden = v !== null;
    },
    setCloudDefault: (v) => {
      slotState.cloudDefault = { value: v };
    },
    get: () => {
      if (slotState.overridden) return slotState.override as T;
      if (IS_CLOUD) {
        return slotState.cloudDefault
          ? (slotState.cloudDefault.value as T)
          : failMissingCloudDefault(name);
      }
      return typeof onpremDefault === "function"
        ? (onpremDefault as () => T)()
        : onpremDefault;
    },
  };
};
