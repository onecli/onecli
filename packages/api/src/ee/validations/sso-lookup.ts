import { z } from "zod";

/** Body for the public login-page lookup — just a syntactically-valid email. */
export const ssoLookupSchema = z.object({
  email: z
    .string({ message: "Email is required" })
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(254, "Enter a valid email address"),
});
