# Zynq

Zynq adalah aplikasi desktop lokal Windows yang mengubah gift TikTok LIVE menjadi input keyboard terkontrol. Runtime desktop memakai Tauri 2, UI memakai React/TypeScript, connector TikTok berjalan sebagai proses Node terpisah melalui JSON-line IPC, dan input keyboard dikirim dari Rust melalui Windows `SendInput`.

> Status: MVP untuk pengujian lokal. Koneksi nyata tetap bergantung pada protokol TikTok yang tidak resmi dan dapat berubah. Simulasi input tidak dijamin diterima semua game, aplikasi elevated, atau target dengan anti-cheat.

## Prasyarat pengembangan

- Windows 10/11 x64 dengan WebView2 Runtime.
- Node.js dan npm.
- Rust stable target `x86_64-pc-windows-msvc`.
- Visual Studio Build Tools dengan workload Desktop development with C++.

## Menjalankan pemeriksaan

```powershell
npm ci
npm --prefix connector ci
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

Jalankan perintah Cargo dari Developer PowerShell/Command Prompt Visual Studio agar linker MSVC tersedia.

## Menjalankan aplikasi

```powershell
npm run prepare:sidecar
npm run tauri dev
```

Gunakan mode simulasi untuk menguji normalisasi gift, rule, cooldown, antrean, dan emergency stop tanpa LIVE aktif. Pilih jendela target non-Zynq; automation hanya mengirim input ketika target tetap berada di foreground.

## Membuat installer

```powershell
npm run tauri build
```

Installer NSIS dibuat di `src-tauri/target/release/bundle/nsis/`. Pipeline build menyalin executable Node host ke nama sidecar target dan membundel connector beserta dependency runtime-nya.

## Batas keselamatan

- `Ctrl+Shift+F10` adalah emergency stop global.
- Input dibatalkan jika target kehilangan fokus, antrean kedaluwarsa, atau generation berubah.
- Rule dibatasi maksimal 200, antrean maksimal 100, repeat maksimal 50, dan durasi action maksimal 10 detik.
- Konfigurasi JSON divalidasi ketat dan dibatasi 1 MiB.

Spesifikasi arsitektur dan batasan lengkap tersedia di [issue.md](issue.md).
