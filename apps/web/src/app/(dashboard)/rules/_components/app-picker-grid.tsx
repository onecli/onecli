"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";

const PAGE_SIZE = 16;

interface AppPickerItem {
  id: string;
  name: string;
  icon: string;
  darkIcon?: string;
}

interface AppPickerGridProps {
  apps: AppPickerItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}

export const AppPickerGrid = ({
  apps,
  selectedId,
  onSelect,
  loading,
}: AppPickerGridProps) => {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(apps.length / PAGE_SIZE);
  const pageApps = apps.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
        {Array.from({ length: PAGE_SIZE }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-2.5 rounded-md border p-2.5"
          >
            <Skeleton className="size-5 shrink-0 rounded" />
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
        {pageApps.map((app) => {
          const isSelected = selectedId === app.id;
          return (
            <button
              key={app.id}
              type="button"
              onClick={() => onSelect(app.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-md border p-2.5 text-left transition-colors",
                isSelected
                  ? "border-brand bg-brand/5"
                  : "hover:bg-muted/50 hover:border-foreground/20",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                <AppIcon
                  icon={app.icon}
                  darkIcon={app.darkIcon}
                  name={app.name}
                  size={18}
                />
              </span>
              <span
                className={cn(
                  "truncate text-xs font-medium",
                  isSelected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {app.name}
              </span>
            </button>
          );
        })}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-3">
          <button
            type="button"
            onClick={() => setPage((p) => p - 1)}
            disabled={page === 0}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:invisible"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                className={cn(
                  "size-2 rounded-full transition-colors",
                  page === i
                    ? "bg-foreground"
                    : "bg-muted-foreground/30 hover:bg-muted-foreground/50",
                )}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={page === totalPages - 1}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:invisible"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
