import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const BRIDGE_PROTOCOL_VERSION = 1;

function localOrigin(origin) {
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export class CreativeBridgeBroker {
  constructor({ host = "127.0.0.1", port = 4765, token = "", requestTimeoutMs = 900_000 } = {}) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
    this.server = undefined;
    this.projects = new Map();
    this.pending = new Map();
  }

  async start() {
    if (this.server) return this.address();
    const server = new WebSocketServer({
      host: this.host,
      port: this.port,
      verifyClient: ({ origin }, done) => {
        const allowed = localOrigin(origin);
        done(allowed, allowed ? 200 : 403, "Only localhost origins are allowed");
      },
    });
    this.server = server;
    server.on("connection", (socket) => this.attach(socket));
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return this.address();
  }

  address() {
    const address = this.server?.address();
    if (!address || typeof address === "string") return { host: this.host, port: this.port };
    return { host: this.host, port: address.port };
  }

  attach(socket) {
    const helloTimer = setTimeout(() => socket.close(4001, "Bridge handshake timed out"), 5_000);
    let projectId;
    socket.on("error", () => socket.close());
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        socket.close(4002, "Invalid JSON");
        return;
      }
      if (!projectId) {
        if (message.type !== "hello" || message.protocolVersion !== BRIDGE_PROTOCOL_VERSION || typeof message.projectId !== "string" || !message.projectId.trim()) {
          socket.close(4003, "Invalid bridge handshake");
          return;
        }
        if (this.token && message.token !== this.token) {
          socket.close(4004, "Invalid bridge token");
          return;
        }
        clearTimeout(helloTimer);
        projectId = message.projectId;
        const existing = this.projects.get(projectId);
        if (existing && existing.socket !== socket) existing.socket.close(4005, "Superseded by a newer project connection");
        this.projects.set(projectId, {
          socket,
          projectId,
          projectTitle: typeof message.projectTitle === "string" ? message.projectTitle : projectId,
          sessionId: typeof message.sessionId === "string" ? message.sessionId : randomUUID(),
          connectedAt: Date.now(),
        });
        socket.send(JSON.stringify({ type: "hello.ack", protocolVersion: BRIDGE_PROTOCOL_VERSION, projectId }));
        return;
      }
      if (message.type !== "response" || typeof message.requestId !== "string") return;
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.socket !== socket) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(typeof message.error === "string" ? message.error : "浏览器执行创作工具失败"));
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (projectId && this.projects.get(projectId)?.socket === socket) this.projects.delete(projectId);
      for (const [requestId, pending] of this.pending) {
        if (pending.socket !== socket) continue;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.removeAbortListener?.();
        pending.reject(new Error("项目工作区已断开 MCP 桥接"));
      }
    });
  }

  listProjects() {
    return [...this.projects.values()].map(({ projectId, projectTitle, sessionId, connectedAt }) => ({ projectId, projectTitle, sessionId, connectedAt }));
  }

  async request(projectId, tool, args, { signal } = {}) {
    const project = this.projects.get(projectId);
    if (!project || project.socket.readyState !== WebSocket.OPEN) throw new Error(`项目 ${projectId} 没有打开并连接 MCP 桥接`);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finishWithError = (error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.removeAbortListener?.();
        reject(error);
      };
      const timer = setTimeout(() => finishWithError(new Error(`创作工具执行超时：${tool}`)), this.requestTimeoutMs);
      let removeAbortListener;
      if (signal) {
        const abort = () => finishWithError(new Error(`创作工具已取消：${tool}`));
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(requestId, { socket: project.socket, resolve, reject, timer, removeAbortListener });
      try {
        project.socket.send(JSON.stringify({ type: "request", protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId, projectId, tool, args }));
      } catch {
        finishWithError(new Error("项目工作区在接收 MCP 请求前已断开"));
      }
    });
  }

  async close() {
    const server = this.server;
    this.server = undefined;
    for (const project of this.projects.values()) project.socket.close(1001, "MCP server shutting down");
    this.projects.clear();
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new Error("MCP server 已关闭"));
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

export { BRIDGE_PROTOCOL_VERSION };
