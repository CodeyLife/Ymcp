import { executeCreativeTool, type CreativeToolName } from "./creative-tool-gateway";

const BRIDGE_PROTOCOL_VERSION = 1;
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:4765";

interface BridgeRequest {
  type: "request";
  protocolVersion: number;
  requestId: string;
  projectId: string;
  tool: CreativeToolName;
  args: Record<string, unknown>;
}

export interface CreativeMcpBridgeOptions {
  projectId: string;
  projectTitle: string;
  url?: string;
  token?: string;
  reconnectDelayMs?: number;
}

function shouldEnableBridge(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_YMCP_MCP_BRIDGE_ENABLED === "true";
}

export function startCreativeMcpBridge(options: CreativeMcpBridgeOptions): () => void {
  if (!shouldEnableBridge()) return () => undefined;
  const url = options.url ?? import.meta.env.VITE_YMCP_MCP_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
  const token = options.token ?? import.meta.env.VITE_YMCP_MCP_TOKEN ?? "";
  const sessionId = crypto.randomUUID();
  let stopped = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();

  const respond = (requestId: string, response: { ok: true; result: unknown } | { ok: false; error: string }) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "response", requestId, ...response }));
  };
  const handleRequest = async (request: BridgeRequest) => {
    if (request.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new Error("MCP 桥接协议版本不兼容");
    if (request.projectId !== options.projectId || request.args.projectId !== options.projectId) throw new Error("MCP 请求的项目作用域与当前工作区不一致");
    const result = await executeCreativeTool(request.tool, request.args);
    respond(request.requestId, { ok: true, result });
  };
  const connect = () => {
    if (stopped) return;
    try { socket = new WebSocket(url); }
    catch {
      retryTimer = setTimeout(connect, options.reconnectDelayMs ?? 2_000);
      return;
    }
    socket.addEventListener("open", () => socket?.send(JSON.stringify({ type: "hello", protocolVersion: BRIDGE_PROTOCOL_VERSION, projectId: options.projectId, projectTitle: options.projectTitle, sessionId, token })));
    socket.addEventListener("message", (event) => {
      let message: unknown;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message || typeof message !== "object" || (message as { type?: string }).type !== "request") return;
      const request = message as BridgeRequest;
      queue = queue.then(() => handleRequest(request)).catch((error) => respond(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
    socket.addEventListener("error", () => socket?.close());
    socket.addEventListener("close", () => { if (!stopped) retryTimer = setTimeout(connect, options.reconnectDelayMs ?? 2_000); });
  };

  connect();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close(1000, "Project workspace closed");
  };
}
