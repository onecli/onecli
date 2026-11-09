import Image from "next/image";

/**
 * The OneCLI mark at the top of the rail. The mark fills only the left 38
 * of its 48-unit box, so it is nudged right to sit on the same centre line
 * as the agents. Preloaded: it is the first thing on every dashboard page,
 * the skeleton's included. 22 wide draws it 23.8 tall (the file is 48 x 52),
 * so the height says 24: a square box made Next warn on every load that
 * the CSS had changed one side only.
 */
export const RailLogoMark = () => (
  <Image
    src="/logo-icon.svg"
    alt=""
    width={22}
    height={24}
    preload
    className="translate-x-[2.3px]"
  />
);
