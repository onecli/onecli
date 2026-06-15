import { z } from "zod";

export const validateTokenSchema = z.object({
  token: z.string().min(1, "token is required"),
});

export const resolveSchema = z.object({
  token: z.string().min(1, "token is required"),
  op_ref: z.string().min(1, "op_ref is required"),
});

export const listVaultsSchema = z.object({
  token: z.string().min(1, "token is required"),
});

export const listItemsSchema = z.object({
  token: z.string().min(1, "token is required"),
  vaultId: z.string().min(1, "vaultId is required"),
});

export const listFieldsSchema = z.object({
  token: z.string().min(1, "token is required"),
  vaultId: z.string().min(1, "vaultId is required"),
  itemId: z.string().min(1, "itemId is required"),
});
