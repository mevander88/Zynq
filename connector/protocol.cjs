"use strict";

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 16 * 1024;
const ID = /^[-A-Za-z0-9:.]{1,128}$/;

function sanitizeText(value, max = 128) {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null;
}

function safeId(value, max = 128) {
  if (typeof value === "string" && /^\d+$/.test(value) && value.length <= max && value !== "0") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function projectGift(data, context) {
  if (!data || typeof data !== "object") throw new Error("Gift payload bukan object");
  const giftId = safeId(data.giftId, 32);
  const senderId = safeId(data.userId);
  const msgId = safeId(data.msgId);
  const groupId = data.groupId == null ? null : safeId(data.groupId);
  const giftType = Number(data.giftType);
  const repeatCount = Number(data.repeatCount ?? 1);
  if (!giftId || !senderId || !msgId) throw new Error("Gift tidak memiliki identity yang aman");
  if (!Number.isSafeInteger(giftType) || giftType < 0) throw new Error("giftType tidak valid");
  if (!Number.isSafeInteger(repeatCount) || repeatCount < 1 || repeatCount > 1_000_000) throw new Error("repeatCount tidak valid");
  if (giftType === 1 && !groupId) throw new Error("Gift streak tidak memiliki groupId");
  return {
    connectionId: context.connectionId,
    roomId: context.roomId,
    msgId,
    senderId,
    giftId,
    giftType,
    repeatCount,
    repeatEnd: giftType === 1 ? data.repeatEnd === true : null,
    groupId,
    giftName: sanitizeText(data.giftName),
    senderLabel: sanitizeText(data.uniqueId),
    receiverUserId: data.receiverUserId == null ? null : safeId(data.receiverUserId)
  };
}

function validateEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Envelope harus object");
  const keys = Object.keys(value).sort();
  const allowed = ["connectionId", "payload", "processId", "protocolVersion", "requestId", "seq", "type"];
  if (keys.some((key) => !allowed.includes(key))) throw new Error("Envelope memiliki field asing");
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new Error("Versi protokol tidak didukung");
  if (typeof value.type !== "string" || !ID.test(value.type)) throw new Error("type tidak valid");
  if (typeof value.processId !== "string" || !ID.test(value.processId)) throw new Error("processId tidak valid");
  if (value.connectionId !== null && (typeof value.connectionId !== "string" || !ID.test(value.connectionId))) throw new Error("connectionId tidak valid");
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) throw new Error("seq tidak valid");
  if (value.requestId !== null && (typeof value.requestId !== "string" || !ID.test(value.requestId))) throw new Error("requestId tidak valid");
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw new Error("payload tidak valid");
  return value;
}

function createLineParser(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_LINE_BYTES && buffer.indexOf(0x0a) < 0) return onError(new Error("Baris IPC melebihi batas"));
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      let line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (!line.length) continue;
      if (line.length > MAX_LINE_BYTES) return onError(new Error("Baris IPC melebihi batas"));
      try { onMessage(validateEnvelope(JSON.parse(line.toString("utf8")))); }
      catch (error) { onError(error); }
    }
  };
}

module.exports = { PROTOCOL_VERSION, MAX_LINE_BYTES, projectGift, validateEnvelope, createLineParser, safeId, sanitizeText };
