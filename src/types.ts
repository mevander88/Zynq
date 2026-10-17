export type ConnectionStatus =
  | "idle"
  | "starting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "stopping"
  | "error";

export type AutomationStatus =
  | "disarmed"
  | "arming"
  | "armed"
  | "emergency_latched"
  | "faulted";

export type RepeatMode = "once" | "per_unit" | "fixed";

export interface Rule {
  id: string;
  enabled: boolean;
  giftId: string;
  giftLabel: string;
  priority: number;
  keys: string[];
  holdMs: number;
  cooldownMs: number;
  repeatMode: RepeatMode;
  fixedCount: number;
  maxRepeats: number;
  repeatGapMs: number;
}

export interface AppConfig {
  schemaVersion: number;
  revision: number;
  live: { username: string };
  rules: Rule[];
  ui: { logVisible: boolean };
}

export interface TargetWindow {
  hwnd: number;
  pid: number;
  title: string;
  processName: string;
  foreground: boolean;
}

export interface GiftCatalogItem {
  id: string;
  name: string;
  diamondCount: number;
}

export interface EventLog {
  id: number;
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface AppSnapshot {
  revision: number;
  connection: ConnectionStatus;
  automation: AutomationStatus;
  roomId: string | null;
  username: string;
  transport: string | null;
  retryAttempt: number;
  statusMessage: string;
  selectedTarget: TargetWindow | null;
  config: AppConfig;
  configDirty: boolean;
  queueDepth: number;
  inputCount: number;
  droppedCount: number;
  logs: EventLog[];
  mockMode: boolean;
  giftCatalog: GiftCatalogItem[];
}

export interface CommandError {
  code: string;
  message: string;
  field?: string;
}
