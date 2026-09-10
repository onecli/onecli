import { describe, it, expect } from "vitest";
import { createApiApp } from "./app";
import {
  getCrypto,
  getSshCa,
  getEventBus,
  getAttachmentStore,
  getOAuthOrg,
  getStrictApiKeyAuth,
  getWorkspaceAccessChecker,
  getSessionEnforcer,
  getSessionThrottle,
  getResourceHooks,
  getConnectionHooks,
  type CryptoService,
  type SshCaSigner,
  type EventBus,
  type AttachmentBlobStore,
  type OAuthOrgHandlers,
  type WorkspaceAccessChecker,
  type SessionEnforcer,
  type SessionThrottle,
  type ResourceHooks,
  type ConnectionHooks,
} from "./providers";
import { createInProcessEventBus } from "./services/event-bus";

describe("createApiApp provider options", () => {
  it("registers provided custom provider options into their provider slots", () => {
    const mockCrypto: CryptoService = {
      encrypt: async (p) => p,
      decrypt: async (c) => c,
    };

    const mockSshCa: SshCaSigner = {
      getPublicKey: async () => Buffer.from("mock_pub"),
      sign: async () => Buffer.from("mock_sig"),
    };

    const mockEventBus: EventBus = createInProcessEventBus();

    const mockAttachmentStore: AttachmentBlobStore = {
      put: async () => ({ storageRef: "mock_ref" }),
      get: async () => Buffer.from("mock_bytes"),
      delete: async () => {},
    };

    const mockOAuthOrg: OAuthOrgHandlers = {
      tryHandleOrgAuthorize: async () => new Response("ok"),
      tryHandleOrgCallback: async () => new Response("ok"),
      tryHandleOrgConnect: async () => new Response("ok"),
    };

    const mockAccessChecker: WorkspaceAccessChecker = {
      canAccessWorkspaceAsUser: async () => true,
      userIsOrgAdmin: async () => true,
    };

    const mockSessionEnforcer: SessionEnforcer = async () => null;

    const mockSessionThrottle: SessionThrottle = async (_c, next) => next();

    const mockResourceHooks: ResourceHooks = {
      beforeCreateAgent: async () => {},
      beforeCreateSecret: async () => {},
    };

    const mockConnectionHooks: ConnectionHooks = {
      beforeCreate: async () => {},
    };

    createApiApp(
      { getSession: async () => null },
      {
        crypto: mockCrypto,
        sshCa: mockSshCa,
        eventBus: mockEventBus,
        attachmentStore: mockAttachmentStore,
        oauthOrg: mockOAuthOrg,
        strictApiKeyAuth: true,
        workspaceAccessChecker: mockAccessChecker,
        sessionEnforcer: mockSessionEnforcer,
        sessionThrottle: mockSessionThrottle,
        resourceHooks: mockResourceHooks,
        connectionHooks: mockConnectionHooks,
      },
    );

    expect(getCrypto()).toBe(mockCrypto);
    expect(getSshCa()).toBe(mockSshCa);
    expect(getEventBus()).toBe(mockEventBus);
    expect(getAttachmentStore()).toBe(mockAttachmentStore);
    expect(getOAuthOrg()).toBe(mockOAuthOrg);
    expect(getStrictApiKeyAuth()).toBe(true);
    expect(getWorkspaceAccessChecker()).toBe(mockAccessChecker);
    expect(getSessionEnforcer()).toBe(mockSessionEnforcer);
    expect(getSessionThrottle()).toBe(mockSessionThrottle);
    expect(getResourceHooks()).toBe(mockResourceHooks);
    expect(getConnectionHooks()).toBe(mockConnectionHooks);
  });
});
