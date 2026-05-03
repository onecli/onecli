import Link from "next/link";
import Image from "next/image";

export default function NotFound() {
  return (
    <div className="flex h-svh flex-col items-center justify-center gap-4">
      <Image
        src="/onecli-full-logo.png"
        alt="OneCLI"
        width={120}
        height={34}
        className="dark:hidden"
      />
      <Image
        src="/onecli-full-logo-dark.png"
        alt="OneCLI"
        width={120}
        height={34}
        className="hidden dark:block"
      />
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground text-sm">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link
        href="/overview"
        className="text-brand text-sm underline underline-offset-4"
      >
        Go to Dashboard
      </Link>
    </div>
  );
}
