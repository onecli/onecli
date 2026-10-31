import type { ReactNode } from "react";

/** The TLS option names a message may tell the user to pick, shown in bold
 *  so the choice stands out. Only literal names: the text is never parsed
 *  as markup. */
const OPTION_NAMES = ["No encryption", "Encrypt only"];

export const emphasizeOptions = (text: string): ReactNode[] =>
  text.split(new RegExp(`(${OPTION_NAMES.join("|")})`)).map((part, i) =>
    OPTION_NAMES.includes(part) ? (
      <strong key={i} className="font-semibold">
        {part}
      </strong>
    ) : (
      part
    ),
  );
