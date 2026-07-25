/**
 * The house "Team" pill marking an app that needs a paid OneCLI plan — the
 * same badge the Connections list (`apps-tab.tsx` AppRow) and `ProAppDialog`
 * render inline. Extracted for the policy editor's cloud-only-app surfaces;
 * the two existing inline copies are untouched (future cleanup).
 */
export const TeamBadge = () => (
  <span className="border-brand/20 bg-brand/5 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5">
    <svg
      width="11"
      height="9"
      viewBox="0 0 44 36"
      fill="none"
      className="-mt-px shrink-0"
      aria-hidden
    >
      <path
        d="M2 2L16 18L2 34"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-brand"
      />
      <path
        d="M22 2L36 18L22 34"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-brand"
      />
    </svg>
    <span className="text-brand text-[11px] font-semibold tracking-wide">
      Team
    </span>
  </span>
);
