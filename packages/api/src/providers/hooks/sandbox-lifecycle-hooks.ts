import type { Prisma } from "@onecli/db";
import type {
  SandboxResourceObservation,
  SandboxStartResources,
} from "@onecli/agent-protocol";

/**
 * The seams a hosted deployment's sandbox-lifecycle extension plugs into.
 * The shared control plane calls each one where a runner's sandbox is
 * claimed, started, created or reported on; a host registers an
 * implementation through `createApiApp({ sandboxLifecycleHooks })`. Every
 * hook is optional, and with none registered (every self-host) each call
 * site behaves exactly as it did before the seam existed: no extra work is
 * claimed, no hold is added to the start arm, a start carries no
 * `resources`, and the extension's runner events are acknowledged and
 * ignored.
 *
 * Deliberately a host-passed registry, not an edition slot: the slot family
 * fails loudly on cloud until `ensureEditionDefaults()` injects a default,
 * and the default here is a separate package the shared code must never
 * import (the dashboard's server actions, which call
 * `ensureEditionDefaults()` and never mount it, must keep working too).
 */
export interface SandboxLifecycleHooks {
  /**
   * An extra predicate the start arm ANDs into its candidate query (`s` is
   * the `sandboxes` alias). Must begin with `AND`; `Prisma.empty` holds
   * nothing.
   */
  startHold?(): Prisma.Sql;
  /**
   * A fence spread into every ordinary lifecycle write on a sandbox row
   * (status, container and home refs): a row the extension holds exclusively
   * matches nothing, so a late runner report can never overwrite it.
   */
  lifecycleWriteFence?(): Prisma.SandboxWhereInput;
  /**
   * Resolve the `resources` a sandbox start carries. A refusal parks the
   * sandbox as unstartable with `code` and `message` (the no-credential
   * precedent), never a 5xx and never a silent default.
   */
  resolveStartResources?(
    sandboxId: string,
    runnerId: string,
  ): Promise<StartResourcesDecision>;
  /** A runner's observation of what a container actually got. */
  recordResourceObservation?(input: {
    runnerId: string;
    sandboxId: string;
    containerRef: string;
    observation: SandboxResourceObservation;
    replicaId: string | undefined;
  }): Promise<void>;
  /**
   * A `starting` progress report with a `reasonCode`, inside the status
   * write's transaction, after the status landed.
   */
  onStartProgress?(
    tx: Prisma.TransactionClient,
    input: { sandboxId: string; runnerId: string; reasonCode: string },
  ): Promise<void>;
  /**
   * After a hosted agent and its sandbox row exist, on the runner they were
   * placed on. Best-effort: a throw is logged and never fails the create.
   */
  afterSandboxCreated?(input: {
    agentId: string;
    sandboxId: string;
    runnerId: string;
  }): Promise<void>;
  /**
   * A running sandbox stopped because its home went read-only (the
   * supervisor's `home_read_only`, forwarded by the runner with the
   * substrate's node). Inside the stop's transaction, after the status
   * landed: the extension records the event and decides whether the
   * automatic restart may happen, and when (`startHold` and
   * `resolveStartResources` enforce it). `node` is absent from a runner
   * that predates it. Without a hook the restart is today's: the next
   * message (or the waiting turn) wakes a fresh boot.
   */
  onHomeReadOnly?(
    tx: Prisma.TransactionClient,
    input: { sandboxId: string; runnerId: string; node?: string },
  ): Promise<void>;
  /**
   * A PERSON restarted the agent ("Restart agent"), inside the restart's
   * transaction. A deliberate restart is the documented way out of a held
   * self-heal, so an extension that budgets automatic restarts clears this
   * sandbox's budget here; it must never touch any other sandbox's state.
   */
  onAgentRestart?(
    tx: Prisma.TransactionClient,
    input: { agentId: string; workspaceId: string },
  ): Promise<void>;
}

export type StartResourcesDecision =
  | { ok: true; resources?: SandboxStartResources }
  | { ok: false; code: string; message: string };

let hooks: SandboxLifecycleHooks = {};

/** Host registration (`createApiApp`) and the test seam (`{}` resets). */
export const initSandboxLifecycleHooks = (h: SandboxLifecycleHooks): void => {
  hooks = h;
};

export const getSandboxLifecycleHooks = (): SandboxLifecycleHooks => hooks;
