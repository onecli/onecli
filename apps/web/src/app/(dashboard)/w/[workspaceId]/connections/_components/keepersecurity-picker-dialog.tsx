"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertCircle,
  AtSign,
  Box,
  Calendar,
  CornerDownLeft,
  CreditCard,
  Database,
  FileText,
  KeyRound,
  Link,
  type LucideIcon,
  Phone,
  Server,
  StickyNote,
  Terminal,
  Type,
  UserRound,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { withWorkspacePrefix } from "@/lib/navigation";
import {
  useKeeperSecurityFields,
  useKeeperSecurityRecords,
} from "@/hooks/use-keepersecurity";
import type {
  KeeperSecurityDisplay,
  KeeperSecurityRecord,
} from "@/lib/api/keepersecurity";

export interface KeeperSecuritySelection {
  ref: string;
  display: KeeperSecurityDisplay;
}

interface KeeperSecurityPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: KeeperSecuritySelection) => void;
  /** Escape hatch for notation the picker doesn't produce (e.g. files). */
  onEnterManually: () => void;
}

interface Row {
  id: string;
  title: string;
  subtitle?: string;
  /** Extra text the search matches on, beyond title and subtitle. */
  keywords?: string;
  icon: LucideIcon;
}

const STEP_META = {
  records: {
    placeholder: "Search records",
    empty: "No records are shared with this Secrets Manager application.",
  },
  fields: {
    placeholder: "Search fields",
    empty: "This record has no filled-in fields a secret can reference.",
  },
} as const;

// Row glyphs reflect the Keeper field / record type so the list reads at a
// glance instead of a column of identical keys.
const FIELD_ICONS: Record<string, LucideIcon> = {
  password: KeyRound,
  secret: KeyRound,
  pinCode: KeyRound,
  keyPair: Terminal,
  login: UserRound,
  email: AtSign,
  url: Link,
  phone: Phone,
  host: Server,
  pamHostname: Server,
  date: Calendar,
  birthDate: Calendar,
  expirationDate: Calendar,
  note: StickyNote,
  multiline: StickyNote,
  paymentCard: CreditCard,
  bankAccount: CreditCard,
  accountNumber: CreditCard,
};

const RECORD_ICONS: Record<string, LucideIcon> = {
  login: UserRound,
  databaseCredentials: Database,
  pamDatabase: Database,
  serverCredentials: Server,
  pamMachine: Server,
  sshKeys: Terminal,
  encryptedNotes: StickyNote,
  bankCard: CreditCard,
  bankAccount: CreditCard,
  file: FileText,
  photo: FileText,
};

/**
 * Builds a `keeper://record/field` reference by drilling Record → Field. The
 * record list is flat (folders show as a subtitle and are searchable) because
 * a Secrets Manager app is often shared individual records with no folder.
 * Field values never load here — only labels and the reference the server
 * computed for each field.
 */
export const KeeperSecurityPickerDialog = ({
  open,
  onOpenChange,
  onSelect,
  onEnterManually,
}: KeeperSecurityPickerDialogProps) => {
  const [record, setRecord] = useState<KeeperSecurityRecord | null>(null);
  const [query, setQuery] = useState("");

  // Each open starts fresh at the record list.
  useEffect(() => {
    if (open) {
      setRecord(null);
      setQuery("");
    }
  }, [open]);

  const step = record ? "fields" : "records";

  const records = useKeeperSecurityRecords(open);
  const fields = useKeeperSecurityFields(record?.uid ?? null);

  const { isLoading, error } = step === "fields" ? fields : records;

  // Build display rows once per data/level change; the filter below re-runs on
  // every keystroke.
  const rows = useMemo<Row[]>(() => {
    if (step === "fields") {
      return (fields.data ?? []).map((f) => ({
        id: f.ref,
        title: f.label,
        icon: FIELD_ICONS[f.fieldType] ?? Type,
      }));
    }
    return (records.data ?? []).map((r) => ({
      id: r.uid,
      title: r.title,
      subtitle: r.folder,
      keywords: r.type,
      icon: RECORD_ICONS[r.type] ?? Box,
    }));
  }, [step, fields.data, records.data]);

  const q = query.trim().toLowerCase();
  const filtered = rows.filter((r) =>
    [r.title, r.subtitle, r.keywords].some((t) => t?.toLowerCase().includes(q)),
  );

  const goToRecords = () => {
    setRecord(null);
    setQuery("");
  };

  const handleRow = (row: Row) => {
    if (step === "records") {
      const picked = records.data?.find((r) => r.uid === row.id);
      if (picked) {
        setRecord(picked);
        setQuery("");
      }
    } else if (record) {
      onSelect({
        ref: row.id,
        display: {
          record: record.title,
          field: row.title,
          ...(record.folder ? { folder: record.folder } : {}),
        },
      });
    }
  };

  const meta = STEP_META[step];
  const ready = !isLoading && !error;
  const pathname = usePathname() ?? "";
  const keeperPage = withWorkspacePrefix(
    pathname,
    "/connections/vaults/keepersecurity",
  );
  // A link to the connection page, where a revoked or unshared connection is
  // explained and can be reconnected.
  const checkConnection = (
    <NextLink
      href={keeperPage}
      onClick={() => onOpenChange(false)}
      className="text-foreground mt-1.5 block w-fit text-xs underline underline-offset-2 hover:no-underline"
    >
      Check the Keeper connection
    </NextLink>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Same frame as the 1Password picker: the result list is the part that
          shrinks, so the path header and search stay on screen. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="space-y-3 border-b px-4 py-3.5 text-left">
          <div className="flex items-center gap-2.5">
            <Image
              src="/icons/keeper-security.png"
              alt=""
              width={22}
              height={22}
              className="shrink-0"
            />
            <DialogTitle className="text-sm font-semibold">
              Reference a Keeper Security field
            </DialogTitle>
            <DialogDescription className="sr-only">
              Browse the records shared with your Keeper Secrets Manager
              application and pick the field this secret reads its value from.
            </DialogDescription>
          </div>

          {/* The keeper:// reference being assembled — segments fill as you drill. */}
          <div className="bg-muted/40 flex items-center gap-1 overflow-hidden rounded-md px-2.5 py-1.5 font-mono text-[13px]">
            <span className="text-muted-foreground/60 shrink-0">keeper://</span>
            <PathSegment
              active={step === "records"}
              label={record?.title}
              placeholder="record"
              onBack={goToRecords}
            />
            <span className="text-muted-foreground/30 shrink-0">/</span>
            <PathSegment active={step === "fields"} placeholder="field" />
          </div>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={meta.placeholder}
            className="h-9"
          />
          {ready && (
            <span className="text-muted-foreground/60 w-6 shrink-0 text-right font-mono text-xs tabular-nums">
              {filtered.length}
            </span>
          )}
        </div>

        <div className="max-h-[18rem] min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 sm:min-h-[7rem]">
          {isLoading ? (
            <div className="space-y-px py-1">
              {["w-28", "w-20", "w-36", "w-16", "w-24"].map((w, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2.5 px-2.5 py-2.5"
                >
                  <Skeleton className="size-3.5 shrink-0 rounded" />
                  <Skeleton className={cn("h-3.5", w)} />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="text-destructive flex items-start gap-2 px-3 py-8 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div>
                <span>
                  {error instanceof Error
                    ? error.message
                    : "Couldn’t reach Keeper."}
                </span>
                {checkConnection}
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-sm">
              {query ? (
                <>
                  Nothing matches{" "}
                  <span className="text-foreground font-mono">{query}</span>.
                </>
              ) : (
                <>{meta.empty}</>
              )}
            </p>
          ) : (
            <div
              key={step}
              className="animate-in fade-in-0 slide-in-from-bottom-1 space-y-px duration-150"
            >
              {filtered.map((row) => {
                const Icon = row.icon;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => handleRow(row)}
                    className="group hover:bg-brand/5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors"
                  >
                    <Icon className="text-muted-foreground/70 group-hover:text-brand size-3.5 shrink-0 transition-colors" />
                    <span className="min-w-0 flex-1">
                      <span className="group-hover:text-foreground block truncate text-sm">
                        {row.title}
                      </span>
                      {row.subtitle && (
                        <span className="text-muted-foreground block truncate text-xs">
                          {row.subtitle}
                        </span>
                      )}
                    </span>
                    {step === "fields" ? (
                      <CornerDownLeft className="text-brand size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                    ) : (
                      <span className="text-brand shrink-0 font-mono text-sm opacity-0 transition-opacity group-hover:opacity-100">
                        /
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t px-4 py-2.5">
          <button
            type="button"
            onClick={onEnterManually}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Enter a reference manually
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * One segment of the `keeper://` reference. A filled segment is tappable to
 * jump back; the segment for the current step glows brand-green.
 */
const PathSegment = ({
  active,
  label,
  placeholder,
  onBack,
}: {
  active: boolean;
  label?: string;
  placeholder: string;
  onBack?: () => void;
}) => {
  if (active) {
    return (
      <span className="text-brand border-brand/50 shrink-0 border-b font-medium">
        {placeholder}
      </span>
    );
  }
  if (label && onBack) {
    return (
      <button
        type="button"
        onClick={onBack}
        className="text-foreground hover:text-brand max-w-[12rem] truncate transition-colors"
      >
        {label}
      </button>
    );
  }
  return (
    <span className="text-muted-foreground/30 shrink-0">{placeholder}</span>
  );
};
