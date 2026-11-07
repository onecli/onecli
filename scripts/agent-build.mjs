#!/usr/bin/env node
// `pnpm agent:build`: the agent sandbox image for local hosted agents, both
// halves in order (the OS base, then the app on it). See scripts/lib/agent-image.mjs.

import { fileURLToPath } from "node:url";
import { buildAgentImages } from "./lib/agent-image.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.exit(buildAgentImages(ROOT) ? 0 : 1);
