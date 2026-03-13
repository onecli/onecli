export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // OSS: ensure the gateway–API shared secret file exists so the gateway can authenticate.
    // Must run before requests arrive so the gateway (which reads on startup) can find it.
    if (process.env.NEXT_PUBLIC_EDITION !== "cloud") {
      const { ensureGatewaySecretFile } = await import("@/lib/gateway-secret");
      ensureGatewaySecretFile();
    }
  }
}
