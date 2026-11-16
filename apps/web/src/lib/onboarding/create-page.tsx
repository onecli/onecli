"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Dices,
  Loader2,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import { toast } from "sonner";
import {
  validateDisplayName,
  DISPLAY_NAME_MAX_LEN,
} from "@onecli/api/validations/display-name";
import {
  useAgentSandboxStatus,
  useCreateHostedAgent,
  useRenameOnboardingAgent,
  useSetStarterFace,
} from "@/hooks/use-agents";
import { randomAgentName } from "@/lib/agents/agent-names";
import { agentFaceUrl, randomAgentFace } from "@/lib/agents/agent-faces";
import type { SandboxStatus } from "@/lib/api/types";
import { hostedCreateRefusalCopy } from "@/lib/agents/availability";
import { agentChatPath } from "@/lib/navigation";
import { useOnboarding } from "./onboarding-context";
import { DEFAULT_AGENT_NAME, nameStepPassed } from "./steps";
import { useScreenExit } from "./use-screen-exit";
import { AppsMarquee } from "./_components/apps-marquee";

/**
 * The boot narrative, in plain words for people who are not engineers.
 * Each line is DONE once the machine has passed its status: the agent
 * exists (`unprovisioned`), its machine is being carved and started
 * (`starting`), it is up (`running`). `{name}` is the agent's name.
 */
const BOOT_LINES: readonly {
  text: string;
  icon: typeof Sparkles;
  doneAt: SandboxStatus;
}[] = [
  { text: "Setting up {name}", icon: Sparkles, doneAt: "starting" },
  {
    text: "Giving {name} a safe space of its own",
    icon: UserRound,
    doneAt: "running",
  },
  // Done with the box: there is no later status to wait for, and the line
  // is the one claim a running machine makes true.
  { text: "Keeping your passwords safe", icon: ShieldCheck, doneAt: "running" },
] as const;

/** The lifecycle, in the order the boot walks it. A status at or past a
 * line's `doneAt` means that line is done. Terminal and held states sit
 * where the person should see progress stop rather than a lie. */
const BOOT_ORDER: readonly SandboxStatus[] = [
  "unprovisioned",
  "starting",
  "running",
];

/**
 * How long the door waits for the machine before opening anyway. A slow
 * boot (a node being brought up) must never hold the person hostage: the
 * chat page shows the greeting as queued and the agent answers when it is
 * up, exactly as it did before the door learned to wait.
 */
export const BOOT_WAIT_MAX_MS = 20_000;

/** Each phase's entrance, keyed on the phase so a swap remounts and replays
 * it: a soft fade and a short rise, slow enough to read as a transition
 * rather than a cut (matches FlowChrome). */
const PHASE_ENTRANCE =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 fill-mode-both duration-500 ease-out";

const bootIndexOf = (status: SandboxStatus | null | undefined): number =>
  status ? BOOT_ORDER.indexOf(status) : -1;

/** The mission and the act of naming the first agent are ONE screen: the
 * picture makes the claim, the name field cashes it in. Three phases —
 * mission (the pitch + one button), form (name it), booting (watch the
 * claims come true, then walk through the "meet your agent" door — the last
 * click of onboarding). The agent itself was created when the flow opened
 * (`ensureAgent`, the welcome step), so its machine has been booting the
 * whole time; the form RENAMES it. Without one (that create was refused),
 * the form creates on submit as it always did. The boot screen's lines
 * follow the machine's real status, and the door opens once it is running
 * (bounded: `BOOT_WAIT_MAX_MS`). A resume with a created agent lands
 * straight on the boot screen. */
export default function CreatePage() {
  const router = useRouter();
  const {
    recordCreatedAgent,
    workspaceId,
    createdAgentId,
    createdAgentName,
    completing,
    handleComplete,
    progress,
  } = useOnboarding();
  const createAgent = useCreateHostedAgent();
  const renameAgent = useRenameOnboardingAgent();
  const setStarterFace = useSetStarterFace();

  // The field opens on a random famous assistant, not the placeholder the
  // early create used (DEFAULT_AGENT_NAME stays that placeholder: resume
  // reads it as "no name picked yet"). A name already given is kept.
  const [name, setName] = useState(() =>
    createdAgentName && createdAgentName !== DEFAULT_AGENT_NAME
      ? createdAgentName
      : randomAgentName([DEFAULT_AGENT_NAME]),
  );
  // A random robot picture beside it; Shuffle rolls both.
  const [face, setFace] = useState<number | null>(() => randomAgentFace());
  const [nameTouched, setNameTouched] = useState(false);
  // Eases the screen away before the hand-off to the chat.
  const { leaving, leave } = useScreenExit();
  // A resume onto a flow whose name step was already passed skips the pitch
  // and the form; a fresh flow always shows them, created agent or not.
  const [phase, setPhase] = useState<"mission" | "form" | "booting">(
    nameStepPassed(progress) ? "booting" : "mission",
  );
  // The first screen arrives with the step itself, and the step frame
  // (FlowChrome) already fades it in. Only later in-step swaps (logos ->
  // name -> getting ready) play their own entrance, so the two never stack.
  const [firstPhase] = useState(phase);
  const entrance = (p: typeof phase) =>
    p === firstPhase ? "" : PHASE_ENTRANCE;
  const submittingRef = useRef(false);
  const unmountedRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const nameError = validateDisplayName(name);
  const showNameError = nameTouched && name.length > 0 && nameError !== null;
  const canSubmit = phase === "form" && name.trim().length > 0 && !nameError;

  // Another name and picture. The placeholder is never offered: a flow left
  // on it would read as "no name picked" on resume.
  const shuffle = () => {
    const next = randomAgentName([DEFAULT_AGENT_NAME], name);
    setName(next);
    setNameTouched(false);
    setFace((current) => randomAgentFace(current));
    nameInput.current?.focus();
    requestAnimationFrame(() =>
      nameInput.current?.setSelectionRange(next.length, next.length),
    );
  };

  const chatDestination =
    createdAgentId && workspaceId
      ? agentChatPath(workspaceId, createdAgentId)
      : undefined;

  // The chat page is a heavy surface and it is where the door leads — have it
  // ready the moment the destination is known.
  useEffect(() => {
    if (chatDestination) router.prefetch(chatDestination);
  }, [router, chatDestination]);

  // The machine's status, read only while the boot screen waits on it.
  const booting = phase === "booting";
  const { data: sandbox } = useAgentSandboxStatus(createdAgentId, {
    enabled: booting,
    workspaceId,
  });
  const bootIndex = bootIndexOf(sandbox?.status);
  const running = sandbox?.status === "running";

  // The bound: the door opens `BOOT_WAIT_MAX_MS` after the boot screen is
  // reached, whatever the machine says. Armed once per entry to the phase.
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (!booting) return;
    const t = setTimeout(() => setWaitedOut(true), BOOT_WAIT_MAX_MS);
    return () => clearTimeout(t);
  }, [booting]);

  // The default opens with the caret parked at its end — Enter accepts it,
  // backspace edits it. Caret, never a selection: selected text is one
  // keystroke from being gone. (Same behavior as the agents-page dialog.)
  useEffect(() => {
    if (phase !== "form") return;
    const id = requestAnimationFrame(() => {
      const end = nameInput.current?.value.length ?? 0;
      nameInput.current?.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(id);
  }, [phase]);

  // Leaving mid-boot (the escape hatch) must not toast an error onto a page
  // the user already left. The flag is re-armed in the effect body:
  // StrictMode runs mount → cleanup → mount, so a cleanup-only write would
  // poison the ref on a page that is still there.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const handleSubmit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    const trimmed = name.trim();
    setPhase("booting");

    try {
      if (createdAgentId) {
        // The agent exists (born at the welcome step): the name is the one
        // thing left to give it. A same-name submit is a server no-op.
        if (trimmed !== createdAgentName) {
          await renameAgent.mutateAsync({
            agentId: createdAgentId,
            name: trimmed,
            workspaceId,
          });
          recordCreatedAgent({ agentId: createdAgentId, agentName: trimmed });
        }
        // The picked picture becomes its avatar (best effort, after the fact).
        if (face !== null) setStarterFace(createdAgentId, face, workspaceId);
        return;
      }
      // The fallback: the welcome step's create was refused (or never ran),
      // so create here and report any refusal as before.
      const agent = await createAgent.mutateAsync({
        name: trimmed,
        workspaceId,
      });
      // Persist the created agent even if the user already left the page.
      recordCreatedAgent({ agentId: agent.id, agentName: agent.name });
      if (face !== null) setStarterFace(agent.id, face, workspaceId);
    } catch (err) {
      if (unmountedRef.current) return;
      toast.error(
        err instanceof Error
          ? hostedCreateRefusalCopy(err)
          : "Failed to create agent",
      );
      setPhase("form");
      submittingRef.current = false;
    }
  };

  // The request still in flight (the rename or the fallback create) holds
  // the first line active: the screen never claims progress it does not
  // have. Once it settles, the machine's status drives the lines.
  const settling = createAgent.isPending || renameAgent.isPending;
  const doneCount = settling
    ? 0
    : BOOT_LINES.filter((line) => bootIndex >= BOOT_ORDER.indexOf(line.doneAt))
        .length;

  // The door opens when the machine is running (every line done) AND the
  // agent truly exists, or at the bound, so a slow boot never traps the
  // person. Never while a request is still settling: a failed one falls
  // back to the form before this can show.
  const ready = !settling && !!chatDestination && (running || waitedOut);

  // The name being set up. While the agent still carries the welcome step's
  // placeholder, the field is the truth (the rename is in flight); once it
  // has a real name (resume included), that name is.
  const bootingName =
    createdAgentName && createdAgentName !== DEFAULT_AGENT_NAME
      ? createdAgentName
      : name.trim();
  const bootLineText = (text: string) => text.replaceAll("{name}", bootingName);

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center transition-[opacity,transform] duration-300 ease-in",
        leaving && "pointer-events-none -translate-y-1 opacity-0",
      )}
    >
      {phase === "mission" ? (
        <div
          key="mission"
          className={cn(
            "flex w-full flex-col items-center text-center",
            entrance("mission"),
          )}
        >
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Works with <span className="text-brand">all your tools</span>,
            safely
          </h1>

          <AppsMarquee className="mt-10" />

          <p className="text-muted-foreground mt-8 text-sm text-balance">
            You decide what your agent can do.{" "}
            <span className="text-brand font-medium">SOC 2 compliant</span>.
          </p>

          <Button
            variant="brand"
            size="lg"
            className="mt-10"
            onClick={() => setPhase("form")}
          >
            Get started
            <ArrowRight className="size-4" aria-hidden />
          </Button>
        </div>
      ) : phase === "form" ? (
        <div
          key="form"
          className={cn(
            "flex w-full flex-col items-center text-center",
            entrance("form"),
          )}
        >
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Name your agent
          </h1>
          <p className="text-muted-foreground mt-3 max-w-md text-balance">
            Everything else (its brief, connections, model) can be changed any
            time from its page.
          </p>

          <form
            className="mt-8 w-full max-w-sm text-left"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <Label htmlFor="agent-name">Agent name</Label>
            <div className="mt-2 flex items-center gap-2">
              {face !== null && (
                // eslint-disable-next-line @next/next/no-img-element -- a static public asset, already sized
                <img
                  src={agentFaceUrl(face)}
                  alt=""
                  width={40}
                  height={40}
                  className="size-10 shrink-0 rounded-lg border object-cover"
                />
              )}
              <Input
                ref={nameInput}
                id="agent-name"
                name="agent-name"
                autoComplete="off"
                spellCheck={false}
                className={cn("h-10", showNameError && "border-destructive")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setNameTouched(true)}
                autoFocus
                maxLength={DISPLAY_NAME_MAX_LEN}
                aria-invalid={showNameError}
                aria-describedby={
                  showNameError ? "agent-name-error" : undefined
                }
              />
              {/* The same Shuffle as the New agent dialog. */}
              <Button
                type="button"
                variant="outline"
                onClick={shuffle}
                aria-label={
                  face !== null ? "Shuffle name and picture" : "Shuffle name"
                }
                title={
                  face !== null
                    ? "Try another name and picture"
                    : "Try another name"
                }
                className="border-brand/30 bg-brand-wash text-brand-ink hover:bg-brand-wash/70 hover:text-brand-ink h-10 shrink-0 gap-1.5 px-3"
              >
                <Dices className="size-4" aria-hidden />
                Shuffle
              </Button>
            </div>
            {showNameError && (
              <p
                id="agent-name-error"
                role="alert"
                className="text-destructive mt-2 text-xs"
              >
                {nameError}
              </p>
            )}
            <Button
              type="submit"
              variant="brand"
              className="mt-8 w-full"
              disabled={!canSubmit}
            >
              Let&apos;s go
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </form>
        </div>
      ) : (
        <div
          key="booting"
          className={cn("w-full max-w-sm", entrance("booting"))}
        >
          <div role="status" aria-label={`Setting up ${bootingName}`}>
            <h1 className="text-center text-3xl font-semibold tracking-tight break-words text-balance sm:text-4xl">
              {bootingName} is getting ready
            </h1>
            {/* The visual list conveys progress via opacity only — this text
                node is what actually changes, so the status region announces
                each line as it becomes active, then the open door. */}
            <p className="sr-only">
              {ready
                ? `${bootingName} is ready to meet you`
                : bootLineText(
                    BOOT_LINES[Math.min(doneCount, BOOT_LINES.length - 1)]
                      ?.text ?? "",
                  )}
            </p>
            <ul className="mt-8 space-y-4">
              {BOOT_LINES.map(({ text, icon: Icon }, i) => {
                const done = ready || doneCount > i;
                const active = !done && doneCount === i;
                return (
                  <li
                    key={text}
                    className={cn(
                      "flex items-center gap-3 transition-opacity",
                      !done && !active && "opacity-30",
                    )}
                  >
                    <span className="bg-brand/10 flex size-8 shrink-0 items-center justify-center rounded-md">
                      {done ? (
                        <Check className="text-brand size-4" aria-hidden />
                      ) : active ? (
                        <Loader2
                          className="text-brand size-4 animate-spin"
                          aria-hidden
                        />
                      ) : (
                        <Icon className="text-brand size-4" aria-hidden />
                      )}
                    </span>
                    <span
                      className={cn("text-sm", done && "text-muted-foreground")}
                    >
                      {bootLineText(text)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* min-h reserves the door's slot so its arrival extends the page
              instead of shoving the narrative upward. */}
          <div className="mt-10 flex min-h-10 justify-center">
            {ready && (
              <Button
                variant="brand"
                size="lg"
                className={PHASE_ENTRANCE}
                onClick={() =>
                  leave(() => void handleComplete(chatDestination))
                }
                loading={completing || leaving}
              >
                Meet {bootingName}
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
