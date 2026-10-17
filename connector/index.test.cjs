"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

test("mock connector can reload the gift catalog", async (context) => {
  const child = spawn(process.execPath, [path.join(__dirname, "index.cjs")], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => { if (!child.killed) child.kill(); });

  const messages = [];
  const diagnostics = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => diagnostics.push(chunk.trim()));
  child.on("exit", (code, signal) => diagnostics.push(`exit:${code}:${signal}`));

  const send = (seq, type, connectionId, payload = {}) => new Promise((resolve, reject) => {
    child.stdin.write(
      `${JSON.stringify({ protocolVersion: 1, type, processId: "test-process", connectionId, seq, requestId: `request-${seq}`, payload })}\n`,
      (error) => error ? reject(error) : resolve()
    );
  });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const match = messages.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timeout menunggu pesan connector. Pesan: ${JSON.stringify(messages)}. Diagnostik: ${diagnostics.join(" | ")}`);
  };

  await send(1, "hello", null, { features: ["gift"] });
  await waitFor((message) => message.type === "ready");
  await send(2, "connect", "test-connection", { username: "simulator", mockMode: true });
  await waitFor((message) => message.type === "gift_catalog" && message.requestId === null);
  await send(3, "refresh_gift_catalog", "test-connection");
  const refreshed = await waitFor((message) => message.type === "gift_catalog" && message.requestId === "request-3");

  assert.deepEqual(refreshed.payload.gifts.map((gift) => gift.name), ["Rose", "Finger Heart"]);
  await send(4, "shutdown", "test-connection");
  child.stdin.end();
});
