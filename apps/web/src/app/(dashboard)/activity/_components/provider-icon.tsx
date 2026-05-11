import Image from "next/image";
import { getProviderIcon } from "@/lib/apps/provider-icons";

interface ProviderIconProps {
  provider: string;
  size?: number;
}

export const ProviderIcon = ({ provider, size = 16 }: ProviderIconProps) => {
  const info = getProviderIcon(provider);
  if (!info) return null;
  return (
    <>
      <Image
        src={info.icon}
        alt={info.name}
        width={size}
        height={size}
        className="dark:hidden"
      />
      <Image
        src={info.darkIcon ?? info.icon}
        alt={info.name}
        width={size}
        height={size}
        className="hidden dark:block"
      />
    </>
  );
};
