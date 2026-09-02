import Link from "next/link";

export default function OrgNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-20">
      <h2 className="text-xl font-semibold">Organization not found</h2>
      <p className="text-sm text-muted-foreground">
        This organization doesn&apos;t exist or you don&apos;t have access.
      </p>
      <Link
        href="/"
        className="text-sm text-brand underline underline-offset-2 hover:text-brand/80"
      >
        Go to Dashboard
      </Link>
    </div>
  );
}
