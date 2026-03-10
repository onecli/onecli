"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@onecli/ui/components/input";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { ChevronDown, Search, X } from "lucide-react";
import { FilterDropdown } from "./filter-dropdown";
import {
  DATE_RANGE_LABELS,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  type AuditFilters,
  type DateRangeKey,
} from "./audit-filters";

export interface AuditFilterBarProps {
  services: string[];
  filters: AuditFilters;
  onFiltersChange: (filters: AuditFilters) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  cli: "Agent",
  app: "App",
};

const URL_DEBOUNCE_MS = 400;

const buildQueryString = (filters: AuditFilters): string => {
  const params = new URLSearchParams();

  if (filters.q) params.set("q", filters.q);
  if (filters.services?.length)
    params.set("service", filters.services.join(","));
  if (filters.statuses?.length)
    params.set("status", filters.statuses.join(","));
  if (filters.sources?.length) params.set("source", filters.sources.join(","));
  if (filters.range && filters.range !== "7d")
    params.set("range", filters.range);

  return params.toString();
};

export const AuditFilterBar = ({
  services,
  filters,
  onFiltersChange,
}: AuditFilterBarProps) => {
  const router = useRouter();

  const [searchValue, setSearchValue] = useState(filters.q ?? "");
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const urlDebounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Sync search input when filters.q changes externally (e.g. clear)
  useEffect(() => {
    setSearchValue(filters.q ?? "");
  }, [filters.q]);

  // Debounced URL sync — uses replace so filter toggles don't pollute history
  const scheduleUrlUpdate = useCallback(
    (next: AuditFilters) => {
      if (urlDebounceRef.current) clearTimeout(urlDebounceRef.current);
      urlDebounceRef.current = setTimeout(() => {
        const qs = buildQueryString(next);
        router.replace(qs ? `/audit?${qs}` : "/audit");
      }, URL_DEBOUNCE_MS);
    },
    [router],
  );

  // Update filters immediately (UI reflects change instantly),
  // but debounce the URL update to avoid cascading re-renders.
  const updateFilters = useCallback(
    (patch: Partial<AuditFilters>) => {
      const next = { ...filters, ...patch };
      onFiltersChange(next);
      scheduleUrlUpdate(next);
    },
    [filters, onFiltersChange, scheduleUrlUpdate],
  );

  const handleSearchChange = (value: string) => {
    setSearchValue(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      updateFilters({ q: value || undefined });
    }, 300);
  };

  const hasActiveFilters =
    !!filters.q ||
    !!filters.services?.length ||
    !!filters.statuses?.length ||
    !!filters.sources?.length ||
    (!!filters.range && filters.range !== "7d");

  const clearAll = () => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (urlDebounceRef.current) clearTimeout(urlDebounceRef.current);
    setSearchValue("");
    const cleared: AuditFilters = {};
    onFiltersChange(cleared);
    // Clear URL immediately — no need to debounce a full reset
    router.replace("/audit");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-shrink-0">
        <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
        <Input
          placeholder="Search actions..."
          value={searchValue}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="h-8 w-52 pl-8 text-sm"
        />
      </div>

      <FilterDropdown
        label="Service"
        options={services}
        selected={filters.services ?? []}
        onSelectionChange={(services) => updateFilters({ services })}
        formatOption={(v) => v.charAt(0).toUpperCase() + v.slice(1)}
        renderOption={(value, formatted) => (
          <span className="flex items-center gap-2">
            <ServiceIcon service={value} />
            {formatted}
          </span>
        )}
      />

      <FilterDropdown
        label="Status"
        options={STATUS_OPTIONS}
        selected={filters.statuses ?? []}
        onSelectionChange={(statuses) => updateFilters({ statuses })}
        formatOption={(v) => v.charAt(0).toUpperCase() + v.slice(1)}
      />

      <FilterDropdown
        label="Source"
        options={SOURCE_OPTIONS}
        selected={filters.sources ?? []}
        onSelectionChange={(sources) => updateFilters({ sources })}
        formatOption={(v) => SOURCE_LABELS[v] ?? v}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            {DATE_RANGE_LABELS[filters.range ?? "7d"]}
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={filters.range ?? "7d"}
            onValueChange={(v) => updateFilters({ range: v as DateRangeKey })}
          >
            {(
              Object.entries(DATE_RANGE_LABELS) as [DateRangeKey, string][]
            ).map(([key, label]) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="gap-1 text-xs"
        >
          <X className="size-3" />
          Clear
        </Button>
      )}
    </div>
  );
};

function ServiceIcon({ service }: { service: string }) {
  const cls = "size-4 shrink-0";
  switch (service.toLowerCase()) {
    case "google":
      return (
        <svg className={cls} viewBox="0 0 24 24">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
      );
    case "github":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
      );
    case "resend":
      return (
        <svg className={cls} viewBox="0 0 1800 1800" fill="currentColor">
          <path d="M1000.46 450C1174.77 450 1278.43 553.669 1278.43 691.282C1278.43 828.896 1174.77 932.563 1000.46 932.563H912.382L1350 1350H1040.82L707.794 1033.48C683.944 1011.47 672.936 985.781 672.935 963.765C672.935 932.572 694.959 905.049 737.161 893.122L908.712 847.244C973.85 829.812 1018.81 779.353 1018.81 713.298C1018.8 632.567 952.745 585.78 871.095 585.78H450V450H1000.46Z" />
        </svg>
      );
    case "onecli":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="#19BA5D">
          <path
            d="M3 4.5L9.5 10L3 15.5"
            stroke="#19BA5D"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d="M11 4.5L17.5 10L11 15.5"
            stroke="#19BA5D"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <rect x="3" y="19" width="16" height="2.5" rx="1.25" />
        </svg>
      );
    default:
      return null;
  }
}
