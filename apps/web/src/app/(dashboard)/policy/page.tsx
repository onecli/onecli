import { PolicyEditor } from "@/lib/policy-editor";

/**
 * The OSS policy console (step 9.5) — the shared project editor at a bare
 * dashboard route. Cloud namespaces its console under `/p/[projectId]/policy`
 * and 404-rewrites bare OSS dashboard routes, so this page ships only in the
 * OSS + onprem-slim URL space.
 */
export default function PolicyPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">Policy</h1>
        <p className="text-muted-foreground text-sm">
          Rules apply top-down; the first match wins.
        </p>
      </div>
      <PolicyEditor scope="project" />
    </div>
  );
}
