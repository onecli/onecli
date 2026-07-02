import { createApiApp } from "@onecli/api";
import { nextSessionProvider } from "./session-provider";
import { eeOverrides } from "@/lib/init/api";
import { APP_VERSION } from "@/lib/env";

export const app = createApiApp(nextSessionProvider, {
  ...eeOverrides,
  version: APP_VERSION,
});
