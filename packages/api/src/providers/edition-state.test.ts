import { afterEach, describe, expect, it, vi } from "vitest";

// The uniform slot semantics every provider seam now shares (override wins,
// null resets, cloud fails loud without injection, onprem resolves the static
// default) — plus the two distinct fail-loud messages. Fresh module per test:
// `IS_CLOUD` and the `applied` flag are captured at import time.

const ORIGINAL_EDITION = process.env.EDITION;
const ORIGINAL_PUBLIC_EDITION = process.env.NEXT_PUBLIC_EDITION;

const loadEditionState = async (edition: "cloud" | "onprem") => {
  vi.resetModules();
  process.env.EDITION = edition === "cloud" ? "cloud" : "";
  process.env.NEXT_PUBLIC_EDITION = process.env.EDITION;
  return import("./edition-state");
};

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.EDITION;
  else process.env.EDITION = ORIGINAL_EDITION;
  if (ORIGINAL_PUBLIC_EDITION === undefined)
    delete process.env.NEXT_PUBLIC_EDITION;
  else process.env.NEXT_PUBLIC_EDITION = ORIGINAL_PUBLIC_EDITION;
  vi.resetModules();
});

describe("createEditionSlot on onprem", () => {
  it("resolves the static onprem default, and a thunk at CALL time", async () => {
    const { createEditionSlot } = await loadEditionState("onprem");
    const byValue = createEditionSlot<string>("byValue", "static");
    expect(byValue.get()).toBe("static");

    let resolved = 0;
    const byThunk = createEditionSlot<string>("byThunk", () => {
      resolved += 1;
      return "lazy";
    });
    expect(resolved).toBe(0); // never at slot creation
    expect(byThunk.get()).toBe("lazy");
    expect(resolved).toBe(1);
  });

  it("override wins over the default; init(null) resets to it", async () => {
    const { createEditionSlot } = await loadEditionState("onprem");
    const slot = createEditionSlot<string>("s", "default");
    slot.init("override");
    expect(slot.get()).toBe("override");
    slot.init(null);
    expect(slot.get()).toBe("default");
  });

  it("ignores an injected cloud default (edition branch, not precedence)", async () => {
    const { createEditionSlot } = await loadEditionState("onprem");
    const slot = createEditionSlot<string>("s", "onprem");
    slot.setCloudDefault("cloud");
    expect(slot.get()).toBe("onprem");
  });
});

describe("createEditionSlot on cloud", () => {
  it("fails loud before ensureEditionDefaults ran, naming the wiring bug", async () => {
    const { createEditionSlot } = await loadEditionState("cloud");
    const slot = createEditionSlot<string>("kms", "never-used");
    expect(() => slot.get()).toThrow(
      /kms: the edition default has not been injected.*ensureEditionDefaults\(\) must run/s,
    );
  });

  it("fails loud AFTER the defaults ran when this injector was skipped", async () => {
    const mod = await loadEditionState("cloud");
    mod.markEditionDefaultsApplied();
    const slot = mod.createEditionSlot<string>("kms", "never-used");
    expect(() => slot.get()).toThrow(
      /kms: ensureEditionDefaults\(\) ran but did not inject/,
    );
  });

  it("resolves the injected cloud default; override wins; null resets to it", async () => {
    const { createEditionSlot } = await loadEditionState("cloud");
    const slot = createEditionSlot<string>("s", "onprem-only");
    slot.setCloudDefault("cloud-default");
    expect(slot.get()).toBe("cloud-default");
    slot.init("override");
    expect(slot.get()).toBe("override");
    slot.init(null);
    expect(slot.get()).toBe("cloud-default");
  });
});

describe("the process-wide slot store", () => {
  // Next dev evaluates route graphs in isolated module registries, so the
  // same seam is instantiated once per graph. The state must be shared by
  // NAME or an injection performed in one graph is invisible to another — on
  // an entitled self-host the role-resolver read as null in layout-only
  // renders and `canAccessWorkspaceAsUser` silently denied the workspace's
  // own owner (the fresh-install /org wedge). Under NODE_ENV=test the store
  // is module-scoped for isolation, so two instantiations WITHIN one module
  // instance stand in for two graphs.
  it("shares one state across re-instantiations of the same slot name", async () => {
    const { createEditionSlot } = await loadEditionState("onprem");
    const graphA = createEditionSlot<string | null>("cross-graph", null);
    const graphB = createEditionSlot<string | null>("cross-graph", null);

    graphA.init("injected-by-graph-a");
    expect(graphB.get()).toBe("injected-by-graph-a");
  });

  it("keeps distinct slot names isolated", async () => {
    const { createEditionSlot } = await loadEditionState("onprem");
    const one = createEditionSlot<string | null>("slot-one", null);
    const two = createEditionSlot<string | null>("slot-two", null);
    one.init("only-in-one");
    expect(two.get()).toBeNull();
  });
});
