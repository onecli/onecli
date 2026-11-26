import Image from "next/image";

interface AppIconProps {
  icon: string;
  darkIcon?: string;
  name: string;
  size?: number;
  /** "eager" for icons that start off-screen but slide into view (the
   * browser's lazy loading would show them blank until they arrive). */
  loading?: "lazy" | "eager";
}

export const AppIcon = ({
  icon,
  darkIcon,
  name,
  size = 18,
  loading,
}: AppIconProps) => {
  if (!darkIcon) {
    return (
      <Image
        src={icon}
        alt={name}
        width={size}
        height={size}
        loading={loading}
      />
    );
  }

  return (
    <>
      <Image
        src={icon}
        alt={name}
        width={size}
        height={size}
        loading={loading}
        className="block dark:hidden"
      />
      <Image
        src={darkIcon}
        alt={name}
        width={size}
        height={size}
        loading={loading}
        className="hidden dark:block"
      />
    </>
  );
};
