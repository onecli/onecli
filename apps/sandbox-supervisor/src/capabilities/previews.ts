import { MAX_PROCESS_COMMAND_CHARS } from "@onecli/agent-protocol";
import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";

/**
 * The previews capability (plans/sandbox-ports.md §8): how a person sees a
 * web app the agent runs. Fragment + one tool, both mounted only when the
 * runner handed the sandbox port streams (`config.previews`, i.e. the
 * deployment has a preview front door): an agent on a deployment without
 * one is never told about a tool that would only refuse. The control plane
 * refuses clearly as well, for the case where the two disagree.
 *
 * The fragment exists because of an observed failure:
 * asked to "make the shop viewable", an agent spent ~25 minutes trying
 * ngrok, cloudflared, and SSH tunnels — all blocked by design — before
 * giving up. The rule is stated up front: tunnels never work here, a
 * preview is the one way in, and a person approves it.
 *
 * Vendor-name-free beyond the tunnel tools the agent would otherwise reach
 * for (naming them is what stops the attempt).
 */
export const previewsFragment: CapabilityFragment = {
  id: "previews",
  title: "Showing a running app to a person (previews)",
  body: `Your machine has no inbound network: nobody can reach a port on it
directly, and tunnels (ngrok, cloudflared, localtunnel, ssh -R, serveo and
similar) are blocked, so do not try them. The one way to let a person open a
web app you run is a preview link:

- Start the app listening on a TCP port (any interface, including
  127.0.0.1). Check it yourself first with \`curl http://localhost:<port>\`.
- Call preview_expose with that port. It returns the final URL
  (https://p<port>-...) immediately, but a person must approve it before
  it opens; the decision arrives as a notice in this conversation. Ask
  once per port: asking again does not speed it up.
- The link is private: only signed-in members of this workspace can open
  it. It keeps the same URL for as long as it is shared, across restarts.
- The app sees requests for the preview hostname over HTTPS, forwarded
  with X-Forwarded-Host / X-Forwarded-Proto. Configure it for the preview
  URL (base URL, allowed hosts, trusted proxies) or it will redirect to
  localhost and break.
- Previews work only while your machine is awake and the app is running.
  Your machine sleeps when nobody is using it, and a sleeping app is not
  held awake by its preview link. Pass startCommand to preview_expose (the
  exact command that starts the app, e.g. \`python3 server.py\` or
  \`docker start metabase\`): when a person opens the link after a sleep,
  the machine wakes and runs that command for them, so the link keeps
  working without you. Without it the person sees "nothing is listening"
  until you start the app again.
  If a person reports the link is down, check the app before anything
  else.`,
};

export const previewsTools: PlatformToolDefinition[] = [
  {
    name: "preview_expose",
    description:
      "Ask for a private preview link to a web app listening on a port on this machine, so a signed-in workspace member can open it in their browser. Returns the final https URL at once; a person must approve it before it works (status 'held'), unless it is already shared (status 'live'). Tunnels do not work here; this is the only way to show a running app.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description:
            "The TCP port the app listens on inside this machine (e.g. 80, 3000, 8080).",
        },
        reason: {
          type: "string",
          maxLength: 300,
          description:
            "One short line for the approver: what they will see (e.g. 'Storefront with the new free-shipping banner').",
        },
        startCommand: {
          type: "string",
          maxLength: MAX_PROCESS_COMMAND_CHARS,
          description:
            "The shell command that starts this app from your home, run for you when a person opens the link after your machine slept (e.g. 'python3 server.py' or 'docker start metabase'). Omit it only for an app that cannot be restarted this way.",
        },
      },
      required: ["port"],
    },
  },
];
