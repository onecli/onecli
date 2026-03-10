export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // OSS: ensure the proxy–API shared secret file exists so the proxy can authenticate.
    // Must run before requests arrive so the proxy (which reads on startup) can find it.
    if (process.env.NEXT_PUBLIC_EDITION !== "cloud") {
      const { ensureProxySecretFile } = await import("@/lib/proxy-secret");
      ensureProxySecretFile();
    }
  }
}
