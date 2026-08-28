import { redirect } from "next/navigation";
import Image from "next/image";
import { AlertTriangle } from "lucide-react";
import { NODE_ENV } from "@/lib/env";

const isDev = NODE_ENV === "development";

const errors: Record<string, { title: string; description: React.ReactNode }> =
  {
    "missing-auth-secret": {
      title: "Auth secret not configured",
      description: (
        <div className="space-y-3">
          <p>
            <Code>BETTER_AUTH_SECRET</Code> is not set, so sessions cannot be
            signed and nobody can log in. Generate one, add it to your
            environment, and restart:
          </p>
          <pre className="bg-muted overflow-x-auto rounded-lg px-3 py-2 text-xs">
            {`openssl rand -base64 32`}
          </pre>
          <p className="text-xs">
            Upgrading from an earlier version? This variable used to be called{" "}
            <Code>NEXTAUTH_SECRET</Code>. Rename it rather than generating a new
            value. Everyone signs in again afterwards either way, and your
            Google OAuth redirect URI now points at the API server (
            <Code>/auth/callback/google</Code>).
          </p>
        </div>
      ),
    },
    "missing-encryption-key": {
      title: "Encryption key not configured",
      description: isDev ? (
        <div className="space-y-3">
          <p>
            <Code>SECRET_ENCRYPTION_KEY</Code> is required to encrypt stored
            secrets. Run this to generate one and add it to your{" "}
            <Code>.env</Code>:
          </p>
          <pre className="bg-muted overflow-x-auto rounded-lg px-3 py-2 text-xs">
            {`echo "SECRET_ENCRYPTION_KEY=$(node -p "require('crypto').randomBytes(32).toString('base64')")" >> .env`}
          </pre>
          <p className="text-xs">Then restart the dev server.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p>
            <Code>SECRET_ENCRYPTION_KEY</Code> is required to encrypt stored
            secrets. Generate one and add it to your environment:
          </p>
          <pre className="bg-muted overflow-x-auto rounded-lg px-3 py-2 text-xs">
            {`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`}
          </pre>
        </div>
      ),
    },
  };

export default async function SetupErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const error = code ? errors[code] : undefined;
  if (!error) redirect("/auth/login");

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
      <div className="mb-8">
        <Image
          src="/onecli-full-logo.png"
          alt="onecli"
          width={140}
          height={40}
          priority
          className="dark:hidden"
        />
        <Image
          src="/onecli-full-logo-dark.png"
          alt="onecli"
          width={140}
          height={40}
          priority
          className="hidden dark:block"
        />
      </div>

      <div className="w-full max-w-md rounded-2xl border border-destructive/50 bg-card p-8">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="size-4 text-destructive" />
          </div>
          <h1 className="text-base font-medium">{error.title}</h1>
        </div>
        <div className="text-muted-foreground mt-4 text-sm leading-relaxed">
          {error.description}
        </div>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{children}</code>
  );
}
