import { customAlphabet } from "nanoid";

// Lowercase letters only — no digits, no upper/lower mixing. Avoids the
// classic 0/o/O, 1/l/I confusion in URLs and when read aloud or copy/pasted
// by support. 16 chars gives ~26^16 ≈ 4×10^22 combinations, plenty for
// Projects and Organizations.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const LENGTH = 16;

const generateId = customAlphabet(ALPHABET, LENGTH);

export const generateProjectId = generateId;
export const generateOrganizationId = generateId;
