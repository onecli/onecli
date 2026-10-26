/**
 * The slice of noVNC 1.7's `RFB` the desktop view uses. The package ships no types and `@types/novnc__novnc`
 * targets the 1.6 layout (`core/rfb` subpath), while 1.7 exports exactly
 * `./core/rfb.js` as its package entry, so the shape is declared here from
 * the 1.7 source (`core/rfb.js`): the constructor, the live-settable
 * properties, and the events the view listens to. Anything the view does
 * not use is deliberately absent, so a future use is a conscious addition
 * here rather than an `any`.
 */
declare module "@novnc/novnc" {
  export interface RFBOptions {
    /** Offered WebSocket subprotocols (the relay reads the ticket here). */
    wsProtocols?: string[];
    credentials?: { username?: string; password?: string; target?: string };
    shared?: boolean;
    repeaterID?: string;
  }

  export interface RFBDisconnectDetail {
    /** True when the close was ours or the server's clean close. */
    clean: boolean;
    reason?: string;
  }

  export interface RFBEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<RFBDisconnectDetail>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    clipboard: CustomEvent<{ text: string }>;
    bell: CustomEvent<Record<string, never>>;
    desktopname: CustomEvent<{ name: string }>;
    capabilities: CustomEvent<{ capabilities: { power: boolean } }>;
    clippingviewport: CustomEvent<boolean>;
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: RFBOptions,
    );
    /** Input is dropped before it is sent; the cursor is still drawn. */
    viewOnly: boolean;
    /** Fit the remote framebuffer into the container, keeping aspect. */
    scaleViewport: boolean;
    /** Clip rather than scroll when the framebuffer is larger. */
    clipViewport: boolean;
    /** Ask the server to resize to the container (needs server support). */
    resizeSession: boolean;
    /** Draw a dot where the remote cursor is when it is otherwise hidden. */
    showDotCursor: boolean;
    /** The container's CSS background behind the framebuffer. */
    background: string;
    /** JPEG quality 0..9 for lossy encodings. */
    qualityLevel: number;
    /** zlib level 0..9 for the lossless encodings. */
    compressionLevel: number;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
      options?: boolean | EventListenerOptions,
    ): void;
  }
}
