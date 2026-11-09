"use client";

import { createContext, useContext } from "react";
import type { CharacterProps } from "@/lib/components/character";
import { useSettingsModal } from "@/lib/settings-modal/modal-context";
import { SETTINGS_PAGE_POSES } from "@/lib/settings-modal/page-poses";
import { PageBanner } from "./page-banner";

type Pose = CharacterProps["name"];

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Renders the header as a light-green banner with this character on the
   * right. Used on every top-level page, so they match. Inside the Settings
   * modal the modal page picks the pose (`SETTINGS_PAGE_POSES`), so pages
   * that sit next to each other there never repeat one. */
  character?: Pose;
  /** The page's main action, kept inside the banner so the banner always
   * spans the full width. */
  action?: React.ReactNode;
}

const PlainHeadersContext = createContext(false);

/**
 * Renders every `PageHeader` below it without a banner, for the second page
 * of a merged Settings page (it already sits under the first one's).
 */
export const PlainPageHeaders = ({
  children,
}: {
  children: React.ReactNode;
}) => (
  <PlainHeadersContext.Provider value={true}>
    {children}
  </PlainHeadersContext.Provider>
);

export const PageHeader = ({
  title,
  description,
  character,
  action,
}: PageHeaderProps) => {
  const plain = useContext(PlainHeadersContext);
  const modal = useSettingsModal();
  const pose =
    plain || !character
      ? undefined
      : modal
        ? SETTINGS_PAGE_POSES[modal.page]
        : character;

  if (!pose)
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-medium tracking-tight">{title}</h1>
          {description && (
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    );

  return (
    <PageBanner
      title={title}
      description={description}
      character={pose}
      action={action}
    />
  );
};
