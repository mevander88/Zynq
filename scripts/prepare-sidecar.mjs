import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Sidecar v1 hanya mendukung Windows x64; diterima ${process.platform}/${process.arch}`);
}

const destination = resolve("src-tauri/binaries/node-x86_64-pc-windows-msvc.exe");
await mkdir(dirname(destination), { recursive: true });
await copyFile(process.execPath, destination);
process.stdout.write(`Node sidecar ${process.version} disiapkan di ${destination}\n`);
