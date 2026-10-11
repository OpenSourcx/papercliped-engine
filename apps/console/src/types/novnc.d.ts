declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { credentials?: { password?: string; username?: string; target?: string }; shared?: boolean; wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    clipViewport: boolean;
    background: string;
    sendCredentials(credentials: { password?: string }): void;
    sendCtrlAltDel(): void;
    focus(options?: FocusOptions): void;
    disconnect(): void;
  }
}
