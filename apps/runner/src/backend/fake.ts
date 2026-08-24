import type {
  ContainerRef,
  ManagedObject,
  SandboxBackend,
  SandboxSnapshot,
  SandboxSpec,
  HomeRef,
} from "./types";

/**
 * An in-memory backend: the proof the seam is genuinely an interface and not
 * a Docker-shaped hole, and what lets the whole runner loop — poll, start,
 * stop, reconcile — be tested with no daemon, no images, and no privileges.
 *
 * It also records what it was asked to do, so tests can assert the SPEC
 * (limits applied, exactly one mount, files delivered) rather than just the
 * outcome.
 */

export interface FakeSandboxRecord {
  spec: SandboxSpec;
  containerRef: ContainerRef;
  running: boolean;
}

export interface FakeBackend extends SandboxBackend {
  readonly sandboxes: Map<string, FakeSandboxRecord>;
  readonly homes: Map<string, HomeRef>;
  readonly prepared: () => boolean;
  /** The runner id the backend was told to label its objects with. */
  readonly owner: () => string | undefined;
  /** Force the next call of a given operation to throw (failure-path tests).
   * The optional error is thrown as-is — how a test plants a TYPED failure
   * (e.g. `ImageUnavailableError`) for the runner's classification. */
  failNext(
    operation: "create" | "start" | "stop" | "list",
    error?: Error,
  ): void;
  /** Make the NEXT call of an operation block until the returned release is
   * called — the deterministic "slow backend" for executor queueing tests
   * (never a sleep; the settled-escape law). */
  holdNext(operation: "create" | "start" | "stop" | "list"): () => void;
  /** Plant a FOREIGN-labeled object (another runner id's leftover) — the
   * orphan sweep's input. Removed by removeSandbox/destroyHome like any
   * other object, so tests assert reaping by its absence. */
  seedManaged(object: ManagedObject): void;
}

export const createFakeBackend = (): FakeBackend => {
  const sandboxes = new Map<string, FakeSandboxRecord>();
  const homes = new Map<string, HomeRef>();
  const failures = new Map<string, Error | undefined>();
  /** Foreign-labeled leftovers planted by tests (the sweep's subjects). */
  let seeded: ManagedObject[] = [];
  let prepared = false;
  let owner: string | undefined;
  let counter = 0;

  const throwIfArmed = (operation: string) => {
    if (!failures.has(operation)) return;
    const planted = failures.get(operation);
    failures.delete(operation);
    throw planted ?? new Error(`fake backend: ${operation} failed`);
  };

  /** operation → gate the next call awaits (armed by holdNext). */
  const holds = new Map<string, Promise<void>>();
  const gateIfHeld = async (operation: string): Promise<void> => {
    const gate = holds.get(operation);
    if (!gate) return;
    holds.delete(operation);
    await gate;
  };

  const byRef = (ref: ContainerRef) =>
    [...sandboxes.values()].find((record) => record.containerRef === ref);

  return {
    id: "fake",
    homeDurability: "resident",
    sandboxes,
    homes,
    prepared: () => prepared,
    owner: () => owner,
    identify(runnerId: string) {
      owner = runnerId;
    },
    failNext(operation, error) {
      failures.set(operation, error);
    },
    holdNext(operation) {
      let release: () => void = () => {};
      holds.set(
        operation,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },

    async prepare() {
      prepared = true;
    },

    async provisionHome(sandboxId) {
      const ref = `fake-home-${sandboxId}`;
      homes.set(sandboxId, ref);
      return ref;
    },

    async destroyHome(ref) {
      for (const [sandboxId, value] of homes) {
        if (value === ref) homes.delete(sandboxId);
      }
      seeded = seeded.filter(
        (object) => object.kind !== "home" || object.ref !== ref,
      );
    },

    async parkHome() {},
    async wakeHome() {},

    async listHomes() {
      return [...homes].map(([sandboxId, ref]) => ({ sandboxId, ref }));
    },

    async createSandbox(spec) {
      await gateIfHeld("create");
      throwIfArmed("create");
      counter += 1;
      const containerRef = `fake-container-${counter}`;
      sandboxes.set(spec.sandboxId, { spec, containerRef, running: false });
      return containerRef;
    },

    async startSandbox(ref) {
      await gateIfHeld("start");
      throwIfArmed("start");
      const record = byRef(ref);
      if (record) record.running = true;
    },

    async stopSandbox(ref) {
      await gateIfHeld("stop");
      throwIfArmed("stop");
      const record = byRef(ref);
      if (record) record.running = false;
    },

    async removeSandbox(ref) {
      for (const [sandboxId, record] of sandboxes) {
        if (record.containerRef === ref) sandboxes.delete(sandboxId);
      }
      seeded = seeded.filter(
        (object) => object.kind !== "sandbox" || object.ref !== ref,
      );
    },

    async listSandboxes(): Promise<SandboxSnapshot[]> {
      throwIfArmed("list");
      return [...sandboxes.values()].map((record) => ({
        sandboxId: record.spec.sandboxId,
        containerRef: record.containerRef,
        running: record.running,
        payloadHash: record.spec.payloadHash,
      }));
    },

    seedManaged(object) {
      seeded.push(object);
    },

    async listManaged(): Promise<ManagedObject[]> {
      const now = new Date();
      const own: ManagedObject[] = [
        ...[...sandboxes.values()].map(
          (record): ManagedObject => ({
            kind: "sandbox",
            ref: record.containerRef,
            sandboxId: record.spec.sandboxId,
            runnerId: owner ?? null,
            // Owned objects are skipped by the runner-id fence anyway; the
            // seeded (foreign) objects a test plants carry explicit values.
            installationId: null,
            createdAt: now,
          }),
        ),
        ...[...homes].map(
          ([sandboxId, ref]): ManagedObject => ({
            kind: "home",
            ref,
            sandboxId,
            runnerId: owner ?? null,
            installationId: null,
            createdAt: now,
          }),
        ),
      ];
      return [...own, ...seeded];
    },
  };
};
