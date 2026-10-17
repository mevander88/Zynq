"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLineParser, projectGift, validateEnvelope } = require("./protocol.cjs");

test("projects gift ids without precision loss", () => {
  const result = projectGift({ giftId: 5953, userId: "6813181309701719620", msgId: "7137749190944230150", giftType: 1, repeatCount: 3, repeatEnd: true, groupId: "1661887131074", giftName: "Rose" }, { connectionId: "c-1", roomId: "7137728632142843000" });
  assert.equal(result.senderId, "6813181309701719620");
  assert.equal(result.repeatCount, 3);
  assert.equal(result.repeatEnd, true);
});

test("rejects unsafe numeric identifiers", () => {
  assert.throws(() => projectGift({ giftId: 5953, userId: 6813181309701719620, msgId: "3", giftType: 0, repeatCount: 1 }, { connectionId: "c", roomId: "r" }), /identity/);
});

test("projects identifiers using the backend digits-only boundary", () => {
  const gift = projectGift(
    { giftId: "5953", userId: "6813181309701719620", msgId: "7137749190944230150", giftType: 0, repeatCount: 1 },
    { connectionId: "connection-1", roomId: "7137728632142843000" }
  );
  for (const value of [gift.roomId, gift.senderId, gift.giftId, gift.msgId]) {
    assert.match(value, /^[0-9]+$/);
  }
});

test("line parser handles split chunks and CRLF", () => {
  const messages = [];
  const errors = [];
  const parser = createLineParser((message) => messages.push(message), (error) => errors.push(error));
  const line = JSON.stringify({ protocolVersion: 1, type: "ping", processId: "p-1", connectionId: null, seq: 1, requestId: "r-1", payload: {} });
  parser(Buffer.from(line.slice(0, 20)));
  parser(Buffer.from(`${line.slice(20)}\r\n`));
  assert.equal(errors.length, 0);
  assert.equal(messages.length, 1);
});

test("envelope rejects foreign fields", () => {
  assert.throws(() => validateEnvelope({ protocolVersion: 1, type: "ping", processId: "p", connectionId: null, seq: 1, requestId: null, payload: {}, extra: true }), /field asing/);
});
