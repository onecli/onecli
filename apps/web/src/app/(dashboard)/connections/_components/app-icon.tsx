import Image from "next/image";

interface AppIconProps {
  icon: string;
  darkIcon?: string;
  name: string;
  size?: number;
}

export const AppIcon = ({ icon, darkIcon, name, size = 18 }: AppIconProps) => {
  if (!darkIcon) {
    return <Image src={icon} alt={name} width={size} height={size} />;
  }

  return (
    <>
      <Image
        src={icon}
        alt={name}
        width={size}
        height={size}
        className="block dark:hidden"
      />
      <Image
        src={darkIcon}
        alt={name}
        width={size}
        height={size}
        className="hidden dark:block"
      />
    </>
  );
};
