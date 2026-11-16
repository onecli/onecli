import "react";

// Lets an inline `style` set CSS custom properties (`{ "--hue": 210 }`)
// without a cast: React's CSSProperties names only standard properties.
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
