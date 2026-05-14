import { customAlphabet } from "nanoid";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const LENGTH = 16;

const generateId = customAlphabet(ALPHABET, LENGTH);

export const generateProjectId = generateId;
export const generateOrganizationId = generateId;
