import type { CapabilityFragment } from "../home/renderer";

/**
 * The machine/persistence capability — fragment-only, unconditional: what
 * survives a sleep or a relaunch is a property of the platform's substrate,
 * not of any harness, and an agent that does not hold the contract loses
 * installed tools and re-pulls container images forever. The durable set is
 * exactly the home volume — /workspace, which now contains the POSIX home
 * (/workspace/.home; docker/agent-entrypoint.sh's contract). The container
 * bullet defers to /etc/containers/README.onecli rather than re-teaching it
 * (one source, no drift), and the background-process line defers to the
 * processes fragment the same way — this fragment must be registered AFTER
 * it for the "above" reference to hold.
 */
export const machineFragment: CapabilityFragment = {
  id: "machine",
  title: "Your machine",
  body: `Your machine is replaced routinely; its disk is not. Your working
directory /workspace — including your home directory ~ (/workspace/.home)
— survives sleep, restarts, and the machine being replaced. Everything
else resets: system directories, /tmp, and anything installed with apt
are gone after a restart.

- To install tools that persist, use \`npm install -g\` or
  \`pip install --user\` — both land under ~/.local, whose bin dir is on
  your PATH — or a venv / project node_modules under /workspace. Never
  rely on an apt install surviving; re-run it after a restart instead.
- Container images, containers, and volumes persist, but running
  containers STOP when the machine sleeps: \`podman start\` (or
  \`docker start\`) the stopped container — do not re-create it, or you
  orphan its state. Details in /etc/containers/README.onecli.
- Background processes do not survive a restart: tracked tasks die and
  their watches fire with "lost" (see Background processes above).`,
};
