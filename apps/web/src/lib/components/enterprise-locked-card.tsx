import { Check, Info } from "lucide-react";
import {
  ENTERPRISE_FEATURES,
  type EnterpriseFeature,
} from "@onecli/api/lib/entitlements";
import { Character } from "@/lib/components/character";
import { ViewPlansButton } from "@/lib/components/view-plans-button";

export interface EnterpriseLockedCardProps {
  feature: EnterpriseFeature;
  /** One sentence on what the locked page/section does. */
  description: string;
  /** The headline after "Unlock". Defaults to the feature's name. */
  title?: string;
  /** What the license turns on, one line each. Defaults to the feature
   * itself with the description under it. */
  details?: { title: string; description: string }[];
}

/**
 * The full-surface locked state for an enterprise page on an unlicensed
 * self-host instance. Rendered INSTEAD of the page's data (the decided
 * posture: the EE surface is dark without a license — pages fetch nothing).
 * Server-component-safe: no hooks, no client APIs.
 *
 * Two halves: what is locked (the character holding a key, on the brand
 * wash, inside quiet rings), and what unlocking it brings, with the one way
 * forward at the bottom.
 */
export const EnterpriseLockedCard = ({
  feature,
  description,
  title = ENTERPRISE_FEATURES[feature],
  details = [{ title: ENTERPRISE_FEATURES[feature], description }],
}: EnterpriseLockedCardProps) => (
  <div className="bg-card grid overflow-hidden rounded-xl border md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
    <div className="bg-brand-wash/60 relative flex min-h-64 flex-col items-center justify-center overflow-hidden px-8 py-10 text-center md:border-r">
      {/* Rings around the character, centred on it: decoration only. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {[180, 300, 420, 540].map((size) => (
          <span
            key={size}
            className="border-brand/15 absolute top-[42%] left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{ width: size, height: size }}
          />
        ))}
      </div>
      <Character name="drop-key" size={84} className="relative" />
      <p className="text-brand-ink relative mt-5 text-[11px] font-medium tracking-wide uppercase">
        OneCLI Enterprise
      </p>
      <h2 className="relative mt-1.5 text-xl font-medium tracking-tight text-balance">
        Unlock {title.charAt(0).toLowerCase() + title.slice(1)}
      </h2>
      <p className="text-muted-foreground relative mt-2 max-w-xs text-sm">
        Available with a OneCLI Enterprise license.
      </p>
    </div>
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Feature details</h3>
        <span className="bg-brand-wash text-brand-ink rounded-md px-2 py-0.5 text-xs font-medium">
          Enterprise feature
        </span>
      </div>
      <ul className="flex flex-col gap-3.5">
        {details.map((item) => (
          <li key={item.title} className="flex gap-2.5">
            <Check className="text-brand mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{item.title}</span>
              <span className="text-muted-foreground block text-sm">
                {item.description}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="bg-muted/60 flex gap-2.5 rounded-lg border px-3.5 py-3">
        <Info
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <p className="text-sm">
          <span className="font-medium">Enterprise license required.</span>{" "}
          <span className="text-muted-foreground">
            Upgrade to OneCLI Enterprise to turn it on for your whole
            organization.
          </span>
        </p>
      </div>
      <ViewPlansButton />
    </div>
  </div>
);
