import Script from "next/script";

// Baked at build time by the cloud image (deploy.yml build-args). Unset —
// every self-host build — means the script never mounts and no site id
// ships in the bundle.
const FATHOM_SITE_ID = process.env.NEXT_PUBLIC_FATHOM_SITE_ID;

export const FathomAnalytics = () =>
  FATHOM_SITE_ID === undefined ? null : (
    <Script
      src="https://cdn.usefathom.com/script.js"
      data-site={FATHOM_SITE_ID}
      data-spa="auto"
      defer
    />
  );
