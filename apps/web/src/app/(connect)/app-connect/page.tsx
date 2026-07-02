import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CAPS } from "@/lib/env";
import { AppsTab } from "@/app/(dashboard)/connections/_components/apps-tab";

/**
 * Connect-only home (onprem-slim). The rest of the dashboard is gated off by the
 * middleware, so this is the landing: pick an app and connect it. Reuses the shared
 * app picker in `connectOnly` mode (no detail-page navigation). Auth is enforced by
 * the surrounding `(connect)/layout.tsx`.
 *
 * Connect-only editions only — full editions have the picker at `/connections`, so this
 * index 404s there (it was a 404 before this landing existed; keeps behavior unchanged).
 */
export default function ConnectHomePage() {
  if (CAPS.webSurface !== "connect-only") notFound();

  return (
    <div className="w-full max-w-5xl self-start py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Connect your apps
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect the tools and services your agents can use.
        </p>
      </div>
      <Suspense>
        <AppsTab connectOnly />
      </Suspense>
    </div>
  );
}
