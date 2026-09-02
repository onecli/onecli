import { describe, expect, it } from "vitest";
import { ED25519_CERT_TYPE, ed25519KeyBlob } from "@onecli/ssh-cert";
import { authenticate, certificateLineOf, type AuthContextLike } from "./auth";
import {
  createTestCa,
  createTestUserKey,
  mintTestCertificate,
} from "./test-fixtures";

interface CtxRecorder extends AuthContextLike {
  accepted: boolean;
  rejected: boolean;
  rejectedMethods: string[] | undefined;
}

const makeCtx = (over: {
  method?: string;
  username?: string;
  key?: { algo: string; data: Buffer };
  signature?: Buffer;
  blob?: Buffer;
}): CtxRecorder => {
  const ctx: CtxRecorder = {
    method: over.method ?? "publickey",
    username: over.username ?? "agent-1",
    key: over.key,
    signature: over.signature,
    blob: over.blob,
    accepted: false,
    rejected: false,
    rejectedMethods: undefined,
    accept() {
      ctx.accepted = true;
    },
    reject(methods) {
      ctx.rejected = true;
      ctx.rejectedMethods = methods;
    },
  };
  return ctx;
};

const ca = createTestCa();
const user = createTestUserKey();

describe("authenticate", () => {
  it("advertises publickey-only for other methods, uncounted", () => {
    const ctx = makeCtx({ method: "none" });
    const outcome = authenticate(ctx, { caPublicKey: ca.publicKey });
    expect(outcome).toEqual({ state: "rejected", counted: false });
    expect(ctx.rejected).toBe(true);
    expect(ctx.rejectedMethods).toEqual(["publickey"]);
  });

  it("rejects password auth", () => {
    const ctx = makeCtx({ method: "password" });
    expect(authenticate(ctx, { caPublicKey: ca.publicKey }).state).toBe(
      "rejected",
    );
  });

  it("rejects a bare (non-certificate) ed25519 key", () => {
    const ctx = makeCtx({
      key: { algo: "ssh-ed25519", data: ed25519KeyBlob(user.publicKey) },
    });
    const outcome = authenticate(ctx, { caPublicKey: ca.publicKey });
    expect(outcome).toEqual({ state: "rejected", counted: true });
    expect(ctx.accepted).toBe(false);
  });

  it("answers PK_OK in the check phase for a valid certificate", async () => {
    const cert = await mintTestCertificate(ca, user);
    const ctx = makeCtx({
      key: { algo: ED25519_CERT_TYPE, data: cert.blob },
    });
    const outcome = authenticate(ctx, { caPublicKey: ca.publicKey });
    expect(outcome.state).toBe("check-passed");
    expect(ctx.accepted).toBe(true);
  });

  it("authenticates when possession is proven in the signature phase", async () => {
    const cert = await mintTestCertificate(ca, user);
    const blob = Buffer.from("signed-auth-blob");
    const ctx = makeCtx({
      key: { algo: ED25519_CERT_TYPE, data: cert.blob },
      blob,
      signature: user.sign(blob),
    });
    const outcome = authenticate(ctx, { caPublicKey: ca.publicKey });
    expect(outcome.state).toBe("authenticated");
    if (outcome.state === "authenticated") {
      expect(outcome.username).toBe("agent-1");
      expect(certificateLineOf(outcome.certificate)).toBe(cert.line);
    }
    expect(ctx.accepted).toBe(true);
  });

  it("rejects a possession signature from the wrong key", async () => {
    const cert = await mintTestCertificate(ca, user);
    const stranger = createTestUserKey();
    const blob = Buffer.from("signed-auth-blob");
    const ctx = makeCtx({
      key: { algo: ED25519_CERT_TYPE, data: cert.blob },
      blob,
      signature: stranger.sign(blob),
    });
    expect(authenticate(ctx, { caPublicKey: ca.publicKey })).toEqual({
      state: "rejected",
      counted: true,
    });
  });

  it("rejects a foreign-CA certificate", async () => {
    const foreignCa = createTestCa();
    const cert = await mintTestCertificate(foreignCa, user);
    const ctx = makeCtx({
      key: { algo: ED25519_CERT_TYPE, data: cert.blob },
    });
    expect(authenticate(ctx, { caPublicKey: ca.publicKey })).toEqual({
      state: "rejected",
      counted: true,
    });
  });

  it("rejects an expired certificate", async () => {
    const cert = await mintTestCertificate(ca, user, {
      validAfter: new Date(Date.now() - 7_200_000),
      validBefore: new Date(Date.now() - 3_600_000),
    });
    const ctx = makeCtx({
      key: { algo: ED25519_CERT_TYPE, data: cert.blob },
    });
    expect(authenticate(ctx, { caPublicKey: ca.publicKey })).toEqual({
      state: "rejected",
      counted: true,
    });
  });

  it("rejects a not-yet-valid certificate", async () => {
    const cert = await mintTestCertificate(ca, user, {
      validAfter: new Date(Date.now() + 3_600_000),
      validBefore: new Date(Date.now() + 7_200_000),
    });
    const ctx = makeCtx({
      key: { algo: ED25519_CERT_TYPE, data: cert.blob },
    });
    expect(authenticate(ctx, { caPublicKey: ca.publicKey }).state).toBe(
      "rejected",
    );
  });

  it("rejects when the username is not the certified principal", async () => {
    const cert = await mintTestCertificate(ca, user, {
      principal: "agent-1",
    });
    const ctx = makeCtx({
      username: "agent-2",
      key: { algo: ED25519_CERT_TYPE, data: cert.blob },
    });
    expect(authenticate(ctx, { caPublicKey: ca.publicKey })).toEqual({
      state: "rejected",
      counted: true,
    });
  });

  it("rejects a tampered certificate blob", async () => {
    const cert = await mintTestCertificate(ca, user);
    const tampered = Buffer.from(cert.blob);
    tampered[tampered.length - 10] =
      (tampered[tampered.length - 10] ?? 0) ^ 0xff;
    const ctx = makeCtx({
      key: { algo: ED25519_CERT_TYPE, data: tampered },
    });
    expect(authenticate(ctx, { caPublicKey: ca.publicKey }).state).toBe(
      "rejected",
    );
  });

  it("rejects a missing key outright", () => {
    const ctx = makeCtx({});
    expect(authenticate(ctx, { caPublicKey: ca.publicKey })).toEqual({
      state: "rejected",
      counted: true,
    });
  });
});
