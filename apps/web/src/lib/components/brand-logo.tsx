import Image from "next/image";

export const BrandLogo = () => (
  <div className="mb-8">
    <Image
      src="/onecli-full-logo.png"
      alt="OneCLI"
      width={140}
      height={40}
      priority
      className="dark:hidden"
    />
    <Image
      src="/onecli-full-logo-dark.png"
      alt="OneCLI"
      width={140}
      height={40}
      priority
      className="hidden dark:block"
    />
  </div>
);
