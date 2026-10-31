import { IS_CLOUD } from "@/lib/env";
import { gatewayHttpOrigin } from "@onecli/api/lib/public-origins";

/** Browser runtime override for self-hosted gateway deployments. */
export const getGatewayApiUrl = (): string => {
  if (IS_CLOUD) return gatewayHttpOrigin();
  const runtime: unknown =
    typeof window !== "undefined" && Reflect.get(window, "__GATEWAY_API_URL__");
  return typeof runtime === "string" && runtime ? runtime : gatewayHttpOrigin();
};
