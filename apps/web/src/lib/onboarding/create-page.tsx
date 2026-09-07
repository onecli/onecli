"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  KeyRound,
  Loader2,
  Sparkles,
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
import { useCreateHostedAgent } from "@/hooks/use-agents";
import { hostedCreateRefusalCopy } from "@/lib/agents/availability";
import { nameToIdentifier } from "@/lib/agents/agent-identifier";
import { agentChatGreetingPath } from "@/lib/navigation";
import { useOnboarding } from "./onboarding-context";
import { WelcomeVisual } from "./_components/welcome-visual";

/** The field opens filled, so nobody faces an empty required box. */
const DEFAULT_AGENT_NAME = "Donna";

/** The boot narrative IS the product pitch: while the sandbox provisions,
 * each line lands as a claim being kept, not marketing copy. Timings are
 * presentational — creation has already succeeded when this plays, and the
 * agent page queues turns sent before the sandbox is up. */
const BOOT_LINES = [
  { text: "Creating your agent", icon: Sparkles },
  { text: "Provisioning an isolated sandbox", icon: Box },
  {
    text: "Zero credentials inside: keys stay in the gateway",
    icon: KeyRound,
  },
] as const;

const BOOT_LINE_MS = 900;

/** House entrance for each phase — keyed on the phase so a swap remounts and
 * replays it, instead of the content snapping in place. */
const PHASE_ENTRANCE =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2";

/** The mission and the act of creating the first agent are ONE screen: the
 * picture makes the claim, the name field cashes it in. Three phases —
 * mission (the pitch + one button), form (name it), booting (watch the
 * claims come true, then walk through the "meet your agent" door — the last
 * click of onboarding). Creation goes through the same POST /v1/agents as the
 * dashboard (same validation, quota and creation-world gates), targeting the
 * boot-resolved default workspace the onboarding URL doesn't carry. A resume
 * with a created agent lands straight on the finished boot screen, where the
 * door is already open. */
export default function CreatePage() {
  const router = useRouter();
  const {
    recordCreatedAgent,
    workspaceId,
    createdAgentId,
    createdAgentName,
    completing,
    handleComplete,
  } = useOnboarding();
  const createAgent = useCreateHostedAgent();

  const [name, setName] = useState(DEFAULT_AGENT_NAME);
  const [nameTouched, setNameTouched] = useState(false);
  // Resume with a created agent skips the pitch and the form — the agent
  // exists, so the only remaining act is meeting it.
  const [phase, setPhase] = useState<"mission" | "form" | "booting">(
    createdAgentId ? "booting" : "mission",
  );
  const [bootStep, setBootStep] = useState(
    createdAgentId ? BOOT_LINES.length : 0,
  );
  const submittingRef = useRef(false);
  const unmountedRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const nameError = validateDisplayName(name);
  const showNameError = nameTouched && name.length > 0 && nameError !== null;
  const canSubmit = phase === "form" && name.trim().length > 0 && !nameError;

  const chatDestination =
    createdAgentId && workspaceId
      ? agentChatGreetingPath(workspaceId, createdAgentId)
      : undefined;

  // The chat page is a heavy surface and it is where the door leads — have it
  // ready the moment the destination is known.
  useEffect(() => {
    if (chatDestination) router.prefetch(chatDestination);
  }, [router, chatDestination]);

  useEffect(() => {
    if (phase !== "booting") return;
    if (bootStep >= BOOT_LINES.length) return;
    const t = setTimeout(() => setBootStep((s) => s + 1), BOOT_LINE_MS);
    return () => clearTimeout(t);
  }, [phase, bootStep]);

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

  const handleCreate = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    const trimmed = name.trim();
    setPhase("booting");
    setBootStep(0);

    let agent;
    try {
      agent = await createAgent.mutateAsync({
        name: trimmed,
        identifier: nameToIdentifier(trimmed),
        workspaceId,
      });
    } catch (err) {
      if (unmountedRef.current) return;
      toast.error(
        err instanceof Error
          ? hostedCreateRefusalCopy(err)
          : "Failed to create agent",
      );
      setPhase("form");
      submittingRef.current = false;
      return;
    }
    // Persist the created agent even if the user already left the page.
    recordCreatedAgent({ agentId: agent.id, agentName: agent.name });
  };

  // The timer chain is presentational and can outrun a slow create — hold the
  // last line in its active (spinner) state until the request actually
  // settles, so the screen never claims "done" while the POST is in flight.
  const shownStep = createAgent.isPending
    ? Math.min(bootStep, BOOT_LINES.length - 1)
    : bootStep;

  // The door opens when the narrative has played out AND the agent truly
  // exists — never on the timers alone, so a slow create keeps its spinner
  // and a failed one falls back to the form before this can show.
  const ready = bootStep >= BOOT_LINES.length && !!chatDestination;

  // The created name is the truth once it exists (resume included); the
  // local field only covers the pre-creation renders of this screen.
  const bootingName = createdAgentName ?? name.trim();

  return (
    <div className="flex w-full flex-col items-center">
      {phase === "mission" ? (
        <div
          key="mission"
          className={cn(
            "flex w-full flex-col items-center text-center",
            PHASE_ENTRANCE,
          )}
        >
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            A sandboxed agent for every employee
          </h1>
          <p className="text-muted-foreground mt-3 text-balance sm:text-lg">
            It never holds your keys. They stay in the gateway, you stay in
            control.
          </p>

          <WelcomeVisual className="mt-8" />

          <Button
            variant="brand"
            size="lg"
            className="mt-10"
            onClick={() => setPhase("form")}
          >
            Create your first agent
            <ArrowRight className="size-4" aria-hidden />
          </Button>
          <p className="text-muted-foreground mt-3 text-xs">
            Under a minute. No keys required.
          </p>
        </div>
      ) : phase === "form" ? (
        <div
          key="form"
          className={cn(
            "flex w-full flex-col items-center text-center",
            PHASE_ENTRANCE,
          )}
        >
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
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
              void handleCreate();
            }}
          >
            <Label htmlFor="agent-name">Agent name</Label>
            <Input
              ref={nameInput}
              id="agent-name"
              name="agent-name"
              autoComplete="off"
              spellCheck={false}
              className={cn("mt-2", showNameError && "border-destructive")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              autoFocus
              maxLength={DISPLAY_NAME_MAX_LEN}
              aria-invalid={showNameError}
              aria-describedby={showNameError ? "agent-name-error" : undefined}
            />
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
              className="mt-4 w-full"
              disabled={!canSubmit}
            >
              Create agent
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </form>

          <div className="mt-10">
            <Button variant="ghost" onClick={() => setPhase("mission")}>
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div key="booting" className={cn("w-full max-w-sm", PHASE_ENTRANCE)}>
          <div role="status" aria-label="Creating your agent">
            <h1 className="text-center font-serif text-3xl font-semibold tracking-tight break-words text-balance sm:text-4xl">
              {bootingName} is starting up
            </h1>
            {/* The visual list conveys progress via opacity only — this text
                node is what actually changes, so the status region announces
                each line as it becomes active, then the open door. */}
            <p className="sr-only">
              {ready
                ? `${bootingName} is ready to meet you`
                : BOOT_LINES[Math.min(shownStep, BOOT_LINES.length - 1)]?.text}
            </p>
            <ul className="mt-8 space-y-4">
              {BOOT_LINES.map(({ text, icon: Icon }, i) => {
                const done = shownStep > i;
                const active = shownStep === i;
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
                      {text}
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
                onClick={() => void handleComplete(chatDestination)}
                loading={completing}
              >
                Meet your agent
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
