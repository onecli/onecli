import { Search, X } from "lucide-react";
import { Input } from "@onecli/ui/components/input";

interface PolicyFilterProps {
  value: string;
  onChange: (value: string) => void;
}

/** Client-side filter over rule name / identity / target (search + clear). */
export const PolicyFilter = ({ value, onChange }: PolicyFilterProps) => (
  <div className="relative w-full sm:w-64">
    <Search
      className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
      aria-hidden
    />
    <Input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Filter rules…"
      aria-label="Filter policy rules"
      className="bg-card h-9 pl-9 text-sm"
    />
    {value && (
      <button
        type="button"
        aria-label="Clear filter"
        onClick={() => onChange("")}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm p-0.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    )}
  </div>
);
