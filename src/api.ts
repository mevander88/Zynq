import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, AppSnapshot, TargetWindow } from "./types";

const hasTauri = () => "__TAURI_INTERNALS__" in window;

export async function getSnapshot(): Promise<AppSnapshot> {
  if (!hasTauri()) return demoSnapshot;
  return invoke<AppSnapshot>("get_snapshot");
}

export async function listenSnapshot(
  callback: (snapshot: AppSnapshot) => void
): Promise<UnlistenFn> {
  if (!hasTauri()) return () => undefined;
  return listen<AppSnapshot>("snapshot", (event) => callback(event.payload));
}

export const commands = {
  connect: (username: string, mockMode: boolean) =>
    invoke<void>("connect_live", { username, mockMode }),
  disconnect: () => invoke<void>("disconnect_live"),
  saveConfig: (config: AppConfig) => invoke<AppSnapshot>("save_config", { config }),
  listTargets: () => invoke<TargetWindow[]>("list_targets"),
  selectTarget: (hwnd: number) => invoke<void>("select_target", { hwnd }),
  start: () => invoke<void>("start_automation"),
  stop: () => invoke<void>("stop_automation"),
  emergency: () => invoke<void>("emergency_stop"),
  resetEmergency: () => invoke<void>("reset_emergency"),
  emitMockGift: (giftId: string, repeatCount: number, streak: boolean) =>
    invoke<void>("emit_mock_gift", { giftId, repeatCount, streak }),
  refreshGiftCatalog: () => invoke<void>("refresh_gift_catalog")
};

const demoRule = (id: string, giftId: string, label: string, key: string): import("./types").Rule => ({
  id,
  enabled: true,
  giftId,
  giftLabel: label,
  priority: 50,
  keys: [key],
  holdMs: 100,
  cooldownMs: 1000,
  repeatMode: "once",
  fixedCount: 1,
  maxRepeats: 10,
  repeatGapMs: 100
});

export const demoSnapshot: AppSnapshot = {
  revision: 1,
  connection: "idle",
  automation: "disarmed",
  roomId: null,
  username: "",
  transport: null,
  retryAttempt: 0,
  statusMessage: "Siap menghubungkan LIVE",
  selectedTarget: null,
  config: {
    schemaVersion: 1,
    revision: 1,
    live: { username: "" },
    rules: [
      demoRule("rule-demo-1", "5655", "Rose", "KeyW"),
      demoRule("rule-demo-2", "5827", "Finger Heart", "Space")
    ],
    ui: { logVisible: true }
  },
  configDirty: false,
  queueDepth: 0,
  inputCount: 0,
  droppedCount: 0,
  logs: [
    { id: 1, timestamp: new Date().toISOString(), level: "info", message: "Mode pratinjau web", detail: "Jalankan melalui Tauri untuk mengaktifkan backend." }
  ],
  mockMode: true,
  giftCatalog: [
    { id: "5655", name: "Rose", diamondCount: 1 },
    { id: "5827", name: "Finger Heart", diamondCount: 5 }
  ],
  giftCatalogStatus: "ready",
  giftCatalogError: null,
  configLoadError: null
};
