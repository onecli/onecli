import { cn } from "@onecli/ui/lib/utils";

// `aspect` is width / height of the drawing's box. Poses that hold something
// (a key, a thought bubble) are wider than the plain characters.
const CHARACTERS = {
  cloud: { src: "/characters/cloud.svg", aspect: 1 },
  drop: { src: "/characters/drop.svg", aspect: 1 },
  "drop-think": { src: "/characters/drop-think.svg", aspect: 315 / 262 },
  "drop-cheer": { src: "/characters/drop-cheer.svg", aspect: 252 / 246 },
  "drop-list": { src: "/characters/drop-list.svg", aspect: 252 / 246 },
  "cloud-key": { src: "/characters/cloud-key.svg", aspect: 277 / 246 },
  "cloud-wait": { src: "/characters/cloud-wait.svg", aspect: 254 / 246 },
  "cloud-mug": { src: "/characters/cloud-mug.svg", aspect: 254 / 246 },
  "cloud-list": { src: "/characters/cloud-list.svg", aspect: 254 / 246 },
  "cloud-think": { src: "/characters/cloud-think.svg", aspect: 315 / 262 },
  "drop-key": { src: "/characters/drop-key.svg", aspect: 265 / 246 },
  "drop-book": { src: "/characters/drop-book.svg", aspect: 252 / 246 },
  "drop-mug": { src: "/characters/drop-mug.svg", aspect: 1 },
} as const;

export interface CharacterProps extends React.ComponentProps<"img"> {
  name: keyof typeof CHARACTERS;
  /** Height in px; the width follows the drawing's own proportions. */
  size?: number;
}

/**
 * One of the two onecli.sh characters (the green cloud and the orange drop),
 * as a static drawing. Decorative only: it never carries meaning the text
 * beside it doesn't, so it is hidden from assistive tech.
 */
export const Character = ({
  name,
  size = 64,
  className,
  ...props
}: CharacterProps) => {
  const { src, aspect } = CHARACTERS[name];
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG; next/image adds nothing here
    <img
      src={src}
      alt=""
      aria-hidden
      width={Math.round(size * aspect)}
      height={size}
      draggable={false}
      className={cn("pointer-events-none shrink-0 select-none", className)}
      {...props}
    />
  );
};
