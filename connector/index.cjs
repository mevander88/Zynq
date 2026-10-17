"use strict";

const crypto = require("node:crypto");
const { createLineParser, projectGift, PROTOCOL_VERSION } = require("./protocol.cjs");

let WebcastPushConnection;
let connectorVersion = "mock";
try {
  ({ WebcastPushConnection } = require("tiktok-live-connector"));
  connectorVersion = require("tiktok-live-connector/package.json").version;
} catch (error) {
  process.stderr.write(`connector dependency unavailable: ${String(error.message).slice(0, 256)}\n`);
}

let processId = null;
let connectionId = null;
let connection = null;
let roomId = null;
let mockMode = false;
let incomingSeq = 0;
let outgoingSeq = 0;
let shuttingDown = false;

function send(type, payload = {}, requestId = null) {
  const envelope = { protocolVersion: PROTOCOL_VERSION, type, processId: processId || "uninitialized", connectionId, seq: ++outgoingSeq, requestId, payload };
  const line = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line) > 16 * 1024) throw new Error("Pesan output terlalu besar");
  if (!process.stdout.write(line)) process.stdin.pause();
}
process.stdout.on("drain", () => process.stdin.resume());

function safeError(error, fallback = "Connector error") {
  const text = error && typeof error.message === "string" ? error.message : String(error ?? fallback);
  return text.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 512) || fallback;
}

function closeConnection() {
  if (connection) {
    try { connection.removeAllListeners(); connection.disconnect(); } catch { /* cleanup is best effort */ }
  }
  connection = null;
  roomId = null;
}

async function handle(message) {
  if (message.seq <= incomingSeq) throw new Error("seq duplikat atau lama");
  if (message.seq !== incomingSeq + 1) throw new Error("gap seq terdeteksi");
  incomingSeq = message.seq;
  if (message.type !== "hello" && (!processId || message.processId !== processId)) throw new Error("processId tidak cocok");
  if (message.type === "hello") {
    if (processId) throw new Error("hello hanya boleh sekali");
    processId = message.processId;
    send("ready", { connectorVersion, nodeVersion: process.version, protocolVersion: PROTOCOL_VERSION }, message.requestId);
    return;
  }
  if (message.type === "ping") { send("pong", {}, message.requestId); return; }
  if (message.type === "disconnect") {
    closeConnection();
    connectionId = message.connectionId;
    send("ack", { command: "disconnect" }, message.requestId);
    send("connection_state", { status: "idle", roomId: null, transport: null });
    return;
  }
  if (message.type === "shutdown") {
    shuttingDown = true;
    closeConnection();
    send("ack", { command: "shutdown" }, message.requestId);
    process.stdin.pause();
    process.exitCode = 0;
    return;
  }
  if (message.type === "mock_gift") {
    if (!mockMode || message.connectionId !== connectionId) throw new Error("mock_gift tidak diizinkan");
    send("gift", message.payload);
    send("ack", { command: "mock_gift" }, message.requestId);
    return;
  }
  if (message.type !== "connect") throw new Error(`Command tidak dikenal: ${message.type}`);
  if (connection) throw new Error("Connector sudah terhubung");
  connectionId = message.connectionId;
  mockMode = message.payload.mockMode === true;
  const username = String(message.payload.username ?? "");
  if (!mockMode && !/^[A-Za-z0-9._]{1,64}$/.test(username)) throw new Error("Username tidak valid");
  send("connection_state", { status: "connecting", roomId: null, transport: null });
  if (mockMode) {
    // Keep mock identifiers inside the same digits-only trust boundary as TikTok IDs.
    roomId = BigInt(`0x${crypto.randomBytes(7).toString("hex")}`).toString(10);
    send("ack", { command: "connect", roomId, transport: "mock" }, message.requestId);
    send("connection_state", { status: "connected", roomId, transport: "mock" });
    return;
  }
  if (!WebcastPushConnection) throw new Error("tiktok-live-connector tidak tersedia");
  const attemptId = connectionId;
  connection = new WebcastPushConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: false,
    enableWebsocketUpgrade: true,
    enableRequestPolling: false,
    requestOptions: { timeout: 10000 }
  });
  connection.on("gift", (data) => {
    if (attemptId !== connectionId || shuttingDown) return;
    try { send("gift", projectGift(data, { connectionId, roomId })); }
    catch (error) { send("error", { code: "INVALID_GIFT", message: safeError(error), retryable: false }); }
  });
  connection.on("disconnected", () => {
    if (attemptId !== connectionId || shuttingDown) return;
    connection = null;
    send("connection_state", { status: "offline", roomId, transport: null });
  });
  connection.on("streamEnd", (value) => {
    const action = value && typeof value === "object" ? value.action : value;
    send("connection_state", { status: "offline", roomId, transport: null, reason: `stream_end_${action ?? "unknown"}` });
  });
  connection.on("error", (value) => send("error", { code: "CONNECTOR_ERROR", message: safeError(value?.exception ?? value), retryable: true }));
  try {
    const state = await connection.connect();
    if (attemptId !== connectionId || shuttingDown) { closeConnection(); return; }
    roomId = String(state.roomId);
    const transport = state.upgradedToWebsocket ? "websocket" : "polling";
    send("ack", { command: "connect", roomId, transport }, message.requestId);
    send("connection_state", { status: "connected", roomId, transport });
  } catch (error) {
    closeConnection();
    send("error", { code: error?.name || "CONNECT_FAILED", message: safeError(error), retryable: true }, message.requestId);
  }
}

const parse = createLineParser(
  (message) => { void handle(message).catch((error) => { try { send("error", { code: "IPC_COMMAND_ERROR", message: safeError(error), retryable: false }, message.requestId); } finally { if (String(error.message).includes("seq") || String(error.message).includes("processId")) process.exitCode = 2; } }); },
  (error) => { process.stderr.write(`ipc protocol error: ${safeError(error)}\n`); process.exitCode = 2; process.stdin.pause(); }
);
process.stdin.on("data", parse);
process.stdin.on("end", () => { closeConnection(); process.exitCode = 0; });
process.on("uncaughtException", (error) => { process.stderr.write(`uncaught: ${safeError(error)}\n`); process.exit(1); });
