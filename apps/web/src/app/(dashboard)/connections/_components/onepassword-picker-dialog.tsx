"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  AlertCircle,
  AtSign,
  Box,
  Calendar,
  Code,
  CornerDownLeft,
  CreditCard,
  Database,
  FileText,
  FolderLock,
  KeyRound,
  Link,
  Link2,
  List,
  type LucideIcon,
  Mail,
  MapPin,
  Phone,
  Server,
  StickyNote,
  Terminal,
  Timer,
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
import {
  useOpFields,
  useOpItems,
  useOpVaults,
} from "@/hooks/use-onepassword-picker";
import { buildOpRef } from "@/lib/api/onepassword";

export interface OpDisplay {
  vault: string;
  item: string;
  field: string;
}

export interface OpSelection {
  opRef: string;
  opDisplay: OpDisplay;
}

interface OnePasswordPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: OpSelection) => void;
}

interface Picked {
  id: string;
  title: string;
}

interface Row {
  id: string;
  title: string;
  icon: LucideIcon;
}

const STEP_META = {
  vaults: {
    placeholder: "Search vaults",
    empty: "No vaults are reachable by this service account.",
  },
  items: {
    placeholder: "Search items",
    empty: "This vault is empty.",
  },
  fields: {
    placeholder: "Search fields",
    empty: "This item has no readable fields.",
  },
} as const;

// The row glyph reflects the field type / item category (1Password SDK enums),
// so the list reads at a glance instead of a column of identical keys.
const FIELD_ICONS: Record<string, LucideIcon> = {
  Concealed: KeyRound,
  Text: Type,
  Email: AtSign,
  Url: Link,
  Totp: Timer,
  Phone: Phone,
  CreditCardNumber: CreditCard,
  CreditCardType: CreditCard,
  Date: Calendar,
  MonthYear: Calendar,
  Address: MapPin,
  SshKey: Terminal,
  Reference: Link2,
  Menu: List,
};

const ITEM_ICONS: Record<string, LucideIcon> = {
  Login: UserRound,
  Password: KeyRound,
  ApiCredentials: Code,
  SecureNote: StickyNote,
  Document: FileText,
  Database: Database,
  Server: Server,
  SshKey: Terminal,
  Email: Mail,
  CreditCard: CreditCard,
};

/**
 * Builds an `op://vault/item/field` reference by drilling Vault → Item → Field.
 * The reference being assembled is the focal point (rendered in mono, like every
 * other technical path in the app); the active segment is lit in brand green.
 * Field values never load here — only labels.
 */
export const OnePasswordPickerDialog = ({
  open,
  onOpenChange,
  onSelect,
}: OnePasswordPickerDialogProps) => {
  const [vault, setVault] = useState<Picked | null>(null);
  const [item, setItem] = useState<Picked | null>(null);
  const [query, setQuery] = useState("");

  // Each open starts fresh at the vault list.
  useEffect(() => {
    if (open) {
      setVault(null);
      setItem(null);
      setQuery("");
    }
  }, [open]);

  const step = item ? "fields" : vault ? "items" : "vaults";

  const vaults = useOpVaults(open);
  const items = useOpItems(vault?.id ?? null);
  const fields = useOpFields(vault?.id ?? null, item?.id ?? null);

  const { isLoading, error } =
    step === "fields" ? fields : step === "items" ? items : vaults;

  // Build display rows once per data/level change. The search filter below
  // re-runs on every keystroke; the map + icon lookup should not.
  const rows = useMemo<Row[]>(() => {
    if (step === "fields") {
      return (fields.data?.fields ?? []).map((f) => ({
        id: f.id,
        title: f.title || f.fieldType,
        icon: FIELD_ICONS[f.fieldType] ?? Type,
      }));
    }
    if (step === "items") {
      return (items.data ?? []).map((i) => ({
        id: i.id,
        title: i.title,
        icon: ITEM_ICONS[i.category] ?? Box,
      }));
    }
    return (vaults.data ?? []).map((v) => ({
      id: v.id,
      title: v.title,
      icon: FolderLock,
    }));
  }, [step, fields.data, items.data, vaults.data]);

  const q = query.trim().toLowerCase();
  const filtered = rows.filter((r) => r.title.toLowerCase().includes(q));

  const goToVaults = () => {
    setVault(null);
    setItem(null);
    setQuery("");
  };
  const goToItems = () => {
    setItem(null);
    setQuery("");
  };

  const handleRow = (row: Row) => {
    if (step === "vaults") {
      setVault({ id: row.id, title: row.title });
      setQuery("");
    } else if (step === "items") {
      setItem({ id: row.id, title: row.title });
      setQuery("");
    } else if (vault && item) {
      onSelect({
        opRef: buildOpRef(vault.id, item.id, row.id),
        opDisplay: { vault: vault.title, item: item.title, field: row.title },
      });
    }
  };

  const meta = STEP_META[step];
  const ready = !isLoading && !error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="space-y-3 border-b px-4 py-3.5 text-left">
          <div className="flex items-center gap-2.5">
            <Image
              src="/icons/onepassword.svg"
              alt=""
              width={22}
              height={22}
              className="shrink-0"
            />
            <DialogTitle className="text-sm font-semibold">
              Reference a 1Password field
            </DialogTitle>
            <DialogDescription className="sr-only">
              Browse your 1Password vaults and pick the field this secret reads
              its value from.
            </DialogDescription>
          </div>

          {/* The op:// reference being assembled — segments fill as you drill. */}
          <div className="bg-muted/40 flex items-center gap-1 overflow-hidden rounded-md px-2.5 py-1.5 font-mono text-[13px]">
            <span className="text-muted-foreground/60 shrink-0">op://</span>
            <PathSegment
              active={step === "vaults"}
              label={vault?.title}
              placeholder="vault"
              onBack={goToVaults}
            />
            <span className="text-muted-foreground/30 shrink-0">/</span>
            <PathSegment
              active={step === "items"}
              label={item?.title}
              placeholder="item"
              onBack={goToItems}
            />
            <span className="text-muted-foreground/30 shrink-0">/</span>
            <PathSegment active={step === "fields"} placeholder="field" />
          </div>
        </DialogHeader>

        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
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

        <div className="max-h-[18rem] min-h-[7rem] overflow-y-auto px-1.5 pb-2">
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
              <span>
                {error instanceof Error
                  ? error.message
                  : "Couldn’t reach 1Password."}
              </span>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-sm">
              {query ? (
                <>
                  Nothing matches{" "}
                  <span className="text-foreground font-mono">{query}</span>.
                </>
              ) : (
                meta.empty
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
                    <span className="group-hover:text-foreground flex-1 truncate text-sm">
                      {row.title}
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
      </DialogContent>
    </Dialog>
  );
};

/**
 * One segment of the `op://` reference. Filled segments are tappable to jump
 * back; the segment for the current step glows brand-green with a caret rule.
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
        className="text-foreground hover:text-brand max-w-[8rem] truncate transition-colors"
      >
        {label}
      </button>
    );
  }
  return (
    <span className="text-muted-foreground/30 shrink-0">{placeholder}</span>
  );
};
