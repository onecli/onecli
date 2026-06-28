import { createApiApp } from "@onecli/api";
import { nextSessionProvider } from "./session-provider";
import { cloudOverrides } from "@/lib/init/api";
import { APP_VERSION } from "@/lib/env";

export const app = createApiApp(nextSessionProvider, {
  ...cloudOverrides,
  version: APP_VERSION,
});
