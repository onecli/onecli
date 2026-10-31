import type { SkillFile } from "@/lib/api";
import { formatBytes } from "@/lib/format-bytes";

export interface SkillFileListProps {
  files: SkillFile[];
}

/**
 * The files of a skill imported from a zip, read-only: path, size, and
 * whether it runs. Re-upload the zip to change them.
 */
export const SkillFileList = ({ files }: SkillFileListProps) => (
  <div className="space-y-2">
    <div className="flex items-baseline justify-between">
      <p className="text-sm font-medium">Files ({files.length + 1})</p>
      <p className="text-muted-foreground text-xs">
        Upload the zip again to change them
      </p>
    </div>
    <ul className="max-h-56 divide-y overflow-y-auto rounded-md border text-sm">
      <li className="flex justify-between gap-3 px-3 py-1.5 font-mono text-xs">
        <span>SKILL.md</span>
        <span className="text-muted-foreground">instructions</span>
      </li>
      {files.map((file) => (
        <li
          key={file.path}
          className="flex justify-between gap-3 px-3 py-1.5 font-mono text-xs"
        >
          <span className="min-w-0 truncate" translate="no" title={file.path}>
            {file.path}
          </span>
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {file.executable ? "runs · " : ""}
            {formatBytes(file.bytes)}
          </span>
        </li>
      ))}
    </ul>
  </div>
);
