import { FormEvent, useEffect, useMemo, useState } from "react";
import { commands, demoSnapshot, getSnapshot, listenSnapshot } from "./api";
import type { AppConfig, AppSnapshot, CommandError, GiftCatalogItem, RepeatMode, Rule, TargetWindow } from "./types";

const KEY_OPTIONS = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => [`Key${key}`, key]),
  ..."0123456789".split("").map((key) => [`Digit${key}`, key]),
  ["Space", "Space"], ["Enter", "Enter"], ["Tab", "Tab"], ["Escape", "Escape"],
  ["ArrowUp", "Arrow ↑"], ["ArrowDown", "Arrow ↓"], ["ArrowLeft", "Arrow ←"], ["ArrowRight", "Arrow →"],
  ...Array.from({ length: 9 }, (_, index) => [`F${index + 1}`, `F${index + 1}`]),
  ["F11", "F11"]
];

const newRule = (): Rule => ({
  id: `rule-${crypto.randomUUID?.() ?? Date.now()}`,
  enabled: true,
  giftId: "",
  giftLabel: "",
  priority: 50,
  keys: ["Space"],
  holdMs: 100,
  cooldownMs: 1000,
  repeatMode: "once",
  fixedCount: 1,
  maxRepeats: 10,
  repeatGapMs: 100
});

function Icon({ name }: { name: "signal" | "bolt" | "target" | "gift" | "log" | "plus" | "trash" | "refresh" }) {
  const paths: Record<string, React.ReactNode> = {
    signal: <><path d="M4 18v2M8 14v6M12 10v10M16 6v14M20 3v17" /></>,
    bolt: <path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" />,
    target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
    gift: <><path d="M3 9h18v12H3zM2 5h20v4H2zM12 5v16" /><path d="M12 5C9 5 7 4 7 2.5 7 1.5 8 1 9 1c2 0 3 4 3 4Zm0 0c3 0 5-1 5-2.5C17 1.5 16 1 15 1c-2 0-3 4-3 4Z" /></>,
    log: <><path d="M5 4h14M5 9h14M5 14h9M5 19h11" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-2 5" /></>
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function StatusDot({ active, warning = false }: { active: boolean; warning?: boolean }) {
  return <span className={`status-dot ${active ? "is-active" : ""} ${warning ? "is-warning" : ""}`} aria-hidden="true" />;
}

function errorText(error: unknown): string {
  if (typeof error === "string") {
    try { return (JSON.parse(error) as CommandError).message ?? error; } catch { return error; }
  }
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "Aksi tidak dapat diselesaikan. Coba lagi.";
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(demoSnapshot);
  const [draft, setDraft] = useState<AppConfig>(demoSnapshot.config);
  const [username, setUsername] = useState("");
  const [mockMode, setMockMode] = useState(true);
  const [targets, setTargets] = useState<TargetWindow[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(true);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void listenSnapshot((next) => {
      if (!live || next.revision < snapshot.revision) return;
      setSnapshot(next);
      setDraft(next.config);
      setUsername(next.config.live.username || next.username);
    }).then((fn) => { unlisten = fn; });
    void getSnapshot().then((next) => {
      if (!live) return;
      setSnapshot(next);
      setDraft(next.config);
      setUsername(next.config.live.username || next.username);
      setMockMode(next.mockMode);
    });
    return () => { live = false; unlisten?.(); };
    // snapshot revision is validated by event stream; initial closure is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name); setNotice(null);
    try { await action(); }
    catch (error) { setNotice(errorText(error)); }
    finally { setBusy(null); }
  };

  const connected = snapshot.connection === "connected";
  const armed = snapshot.automation === "armed";
  const emergency = snapshot.automation === "emergency_latched";
  const configDirty = JSON.stringify(draft) !== JSON.stringify(snapshot.config);
  const canStart = connected && !!snapshot.selectedTarget && !configDirty && !emergency && snapshot.automation === "disarmed";

  const connectionLabel: Record<string, string> = {
    idle: "Belum terhubung", starting: "Menyiapkan connector", connecting: "Menghubungkan",
    connected: "LIVE terhubung", reconnecting: "Menghubungkan ulang", offline: "LIVE offline",
    stopping: "Memutus koneksi", error: "Koneksi bermasalah"
  };

  const visibleLogs = useMemo(() => snapshot.logs.slice(-80).reverse(), [snapshot.logs]);

  const connect = (event: FormEvent) => {
    event.preventDefault();
    void run("connect", () => commands.connect(username, mockMode));
  };

  const save = () => void run("save", async () => {
    const next = structuredClone(draft);
    next.live.username = username;
    const saved = await commands.saveConfig(next);
    setSnapshot(saved);
    setDraft(saved.config);
  });

  const refreshTargets = () => void run("targets", async () => setTargets(await commands.listTargets()));

  const saveRule = (rule: Rule) => {
    setDraft((current) => ({
      ...current,
      rules: current.rules.some((item) => item.id === rule.id)
        ? current.rules.map((item) => item.id === rule.id ? rule : item)
        : [...current.rules, rule]
    }));
    setEditing(null);
  };

  return (
    <div className={`app-shell automation-${snapshot.automation}`}>
      <a className="skip-link" href="#main-content">Lewati ke kontrol utama</a>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span>Z</span></div>
          <div><strong>ZYNQ</strong><span>LIVE CONTROL DESK</span></div>
        </div>
        <div className="system-strip" aria-live="polite">
          <span><StatusDot active={connected} />{connectionLabel[snapshot.connection]}</span>
          <span><StatusDot active={armed} warning={emergency} />{emergency ? "Emergency terkunci" : armed ? "Automation aktif" : "Automation aman"}</span>
          <span className="shortcut-label">STOP <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>F10</kbd></span>
        </div>
      </header>

      <main id="main-content">
        <section className="command-deck" aria-labelledby="desk-title">
          <div className="desk-heading">
            <p className="eyebrow">SESSION / {snapshot.mockMode ? "SIMULATION" : "LIVE"}</p>
            <h1 id="desk-title">Gift masuk.<br />Aksi <em>terkendali.</em></h1>
            <p>Hubungkan satu LIVE, pilih target foreground, lalu aktifkan aturan saat Anda siap.</p>
          </div>
          <div className="master-controls">
            <div className="master-readout">
              <span className="readout-label">MASTER STATE</span>
              <strong>{snapshot.automation.replace("_", " ").toUpperCase()}</strong>
              <small>{snapshot.statusMessage}</small>
            </div>
            <div className="master-actions">
              {emergency ? (
                <button className="button reset-button" onClick={() => void run("reset", commands.resetEmergency)} disabled={!!busy}>Reset emergency</button>
              ) : armed ? (
                <button className="button stop-button" onClick={() => void run("stop", commands.stop)} disabled={!!busy}>Stop automation</button>
              ) : (
                <button className="button start-button" onClick={() => void run("start", commands.start)} disabled={!canStart || !!busy}>Start automation</button>
              )}
              <button className="emergency-button" onClick={() => void run("emergency", commands.emergency)} disabled={emergency || !!busy}>
                <span>EMERGENCY</span><strong>STOP</strong>
              </button>
            </div>
            {!canStart && !armed && !emergency && <p className="start-hint">{!connected ? "Hubungkan LIVE terlebih dahulu." : !snapshot.selectedTarget ? "Pilih jendela target." : configDirty ? "Simpan perubahan aturan." : "Automation belum siap."}</p>}
          </div>
        </section>

        {notice && <div className="notice" role="alert"><strong>Aksi belum selesai.</strong> {notice}<button aria-label="Tutup pesan" onClick={() => setNotice(null)}>×</button></div>}

        <section className="setup-grid" aria-label="Pengaturan sesi">
          <article className="setup-panel connection-panel">
            <div className="section-heading"><span className="section-number">01</span><div><Icon name="signal" /><h2>Koneksi LIVE</h2></div></div>
            <form onSubmit={connect} className="connection-form">
              <label htmlFor="username">Username TikTok</label>
              <div className="input-affix"><span>@</span><input id="username" value={username} onChange={(event) => setUsername(event.target.value.replace(/^@/, ""))} placeholder="nama_streamer" disabled={connected} autoComplete="off" /></div>
              <label className="switch-row"><input type="checkbox" checked={mockMode} onChange={(event) => setMockMode(event.target.checked)} disabled={connected} /><span className="switch" /><span><strong>Mode simulasi</strong><small>Uji alur tanpa terhubung ke TikTok</small></span></label>
              <div className="inline-actions">
                {!connected ? <button className="button primary" disabled={busy === "connect" || (!mockMode && !username.trim())}>{busy === "connect" ? "Menghubungkan…" : "Hubungkan LIVE"}</button> : <button type="button" className="button secondary" onClick={() => void run("disconnect", commands.disconnect)}>Putuskan koneksi</button>}
                <span className={`state-chip state-${snapshot.connection}`}><StatusDot active={connected} />{connectionLabel[snapshot.connection]}</span>
              </div>
            </form>
            <dl className="metadata-list">
              <div><dt>Room</dt><dd>{snapshot.roomId ?? "—"}</dd></div>
              <div><dt>Transport</dt><dd>{snapshot.transport ?? "—"}</dd></div>
              <div><dt>Retry</dt><dd>{snapshot.retryAttempt}</dd></div>
            </dl>
          </article>

          <article className="setup-panel target-panel">
            <div className="section-heading"><span className="section-number">02</span><div><Icon name="target" /><h2>Target input</h2></div></div>
            <p className="panel-copy">Input hanya dikirim ketika jendela ini berada di foreground.</p>
            <button className="button secondary icon-label" onClick={refreshTargets} disabled={busy === "targets"}><Icon name="refresh" />{busy === "targets" ? "Memindai…" : "Pindai jendela"}</button>
            <div className="target-list">
              {targets.length === 0 && !snapshot.selectedTarget && <div className="empty-state"><span>Belum ada target</span><small>Pindai jendela desktop, lalu pilih aplikasi atau game.</small></div>}
              {snapshot.selectedTarget && !targets.some((item) => item.hwnd === snapshot.selectedTarget?.hwnd) && <TargetButton target={snapshot.selectedTarget} selected onSelect={() => undefined} />}
              {targets.map((target) => <TargetButton key={String(target.hwnd)} target={target} selected={snapshot.selectedTarget?.hwnd === target.hwnd} onSelect={() => void run("target", () => commands.selectTarget(target.hwnd))} />)}
            </div>
          </article>
        </section>

        <section className="rules-section" aria-labelledby="rules-title">
          <div className="section-header-wide">
            <div><span className="section-number">03</span><p className="eyebrow">ROUTING TABLE</p><h2 id="rules-title">Gift → Keybind</h2></div>
            <div className="rules-actions"><span>{draft.rules.filter((rule) => rule.enabled).length} aktif / {draft.rules.length} aturan</span><button className="button primary icon-label" onClick={() => setEditing(newRule())}><Icon name="plus" />Tambah aturan</button></div>
          </div>

          <div className="rules-table" role="table" aria-label="Daftar aturan gift">
            <div className="rule-row rule-header" role="row"><span>Status</span><span>Gift</span><span>Keybind</span><span>Timing</span><span>Repeat</span><span>Priority</span><span>Aksi</span></div>
            {draft.rules.length === 0 && <div className="rules-empty"><Icon name="gift" /><strong>Belum ada rute gift</strong><span>Tambahkan gift ID dan tombol yang akan dijalankan.</span><button className="button primary" onClick={() => setEditing(newRule())}>Buat aturan pertama</button></div>}
            {draft.rules.map((rule) => (
              <div className={`rule-row ${!rule.enabled ? "is-disabled" : ""}`} role="row" key={rule.id}>
                <span data-label="Status"><button className={`toggle ${rule.enabled ? "on" : ""}`} aria-label={`${rule.enabled ? "Nonaktifkan" : "Aktifkan"} ${rule.giftLabel || rule.giftId}`} onClick={() => setDraft((current) => ({ ...current, rules: current.rules.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item) }))}><span /></button></span>
                <span data-label="Gift"><strong>{rule.giftLabel || "Gift tanpa label"}</strong><small>ID {rule.giftId || "belum diisi"}</small></span>
                <span data-label="Keybind" className="key-chord">{rule.keys.map((key) => <kbd key={key}>{key.replace(/^Key/, "")}</kbd>)}</span>
                <span data-label="Timing"><strong>{rule.holdMs} ms</strong><small>Cooldown {rule.cooldownMs} ms</small></span>
                <span data-label="Repeat"><strong>{repeatLabel(rule.repeatMode)}</strong><small>Maks. {rule.maxRepeats}×</small></span>
                <span data-label="Priority"><span className="priority-mark">P{rule.priority}</span></span>
                <span data-label="Aksi" className="row-actions"><button onClick={() => setEditing(structuredClone(rule))}>Edit</button><button className="trash" aria-label={`Hapus ${rule.giftLabel || rule.giftId}`} onClick={() => setDraft((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) }))}><Icon name="trash" /></button></span>
              </div>
            ))}
          </div>
          <div className="save-bar"><span>{configDirty ? "Perubahan belum disimpan" : `Konfigurasi revision ${snapshot.config.revision} tersimpan`}</span><button className="button primary" onClick={save} disabled={!configDirty || !!busy}>{busy === "save" ? "Menyimpan…" : "Simpan konfigurasi"}</button></div>
        </section>

        {snapshot.mockMode && connected && <MockConsole rules={draft.rules} onEmit={(giftId, count, streak) => void run("mock", () => commands.emitMockGift(giftId, count, streak))} />}

        <section className="telemetry" aria-labelledby="telemetry-title">
          <div className="telemetry-stats">
            <div><span>QUEUE</span><strong>{snapshot.queueDepth.toString().padStart(2, "0")}</strong></div>
            <div><span>INPUT SENT</span><strong>{snapshot.inputCount.toString().padStart(2, "0")}</strong></div>
            <div><span>DROPPED</span><strong>{snapshot.droppedCount.toString().padStart(2, "0")}</strong></div>
          </div>
          <div className="log-panel">
            <button className="log-heading" onClick={() => setShowLogs((value) => !value)} aria-expanded={showLogs}><span><Icon name="log" /><strong id="telemetry-title">Event log</strong></span><small>{showLogs ? "Tutup" : "Buka"}</small></button>
            {showLogs && <div className="log-stream" aria-live="polite">{visibleLogs.length === 0 ? <div className="empty-log">Event koneksi, gift, dan input akan muncul di sini.</div> : visibleLogs.map((log) => <div className={`log-line level-${log.level}`} key={log.id}><time>{new Date(/^\d+$/.test(log.timestamp) ? Number(log.timestamp) : log.timestamp).toLocaleTimeString("id-ID", { hour12: false })}</time><span className="log-level">{log.level}</span><div><strong>{log.message}</strong>{log.detail && <small>{log.detail}</small>}</div></div>)}</div>}
          </div>
        </section>
      </main>

      <footer><span>ZYNQ / LOCAL DESKTOP CONTROLLER</span><span>Input dikirim ke Windows; penerimaan oleh game tidak dijamin.</span></footer>
      {editing && <RuleEditor rule={editing} gifts={snapshot.giftCatalog} onSave={saveRule} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TargetButton({ target, selected, onSelect }: { target: TargetWindow; selected: boolean; onSelect: () => void }) {
  return <button className={`target-item ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}><span className="app-initial">{target.processName.slice(0, 1).toUpperCase()}</span><span><strong>{target.title}</strong><small>{target.processName} · PID {target.pid}</small></span><span className="target-state">{target.foreground ? "Foreground" : selected ? "Dipilih" : "Pilih"}</span></button>;
}

function RuleEditor({ rule: initial, gifts, onSave, onClose }: { rule: Rule; gifts: GiftCatalogItem[]; onSave: (rule: Rule) => void; onClose: () => void }) {
  const [rule, setRule] = useState(initial);
  const [error, setError] = useState("");
  const giftOptions = useMemo(() => {
    if (!rule.giftId || gifts.some((gift) => gift.id === rule.giftId)) return gifts;
    return [{ id: rule.giftId, name: rule.giftLabel || `Gift ${rule.giftId}`, diamondCount: 0 }, ...gifts];
  }, [gifts, rule.giftId, rule.giftLabel]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{1,32}$/.test(rule.giftId) || rule.giftId === "0") { setError("Gift ID harus berupa angka positif, maksimal 32 digit."); return; }
    if (rule.keys.length === 0) { setError("Pilih setidaknya satu tombol."); return; }
    onSave(rule);
  };
  const setNumber = (field: keyof Rule, value: string) => setRule((current) => ({ ...current, [field]: Number(value) }));
  return <div className="editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="rule-editor" onSubmit={submit} aria-labelledby="editor-title">
      <header><div><p className="eyebrow">RULE EDITOR</p><h2 id="editor-title">Rute gift baru</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Tutup editor">×</button></header>
      {error && <p className="field-error" role="alert">{error}</p>}
      <label>Jenis gift<select value={rule.giftId} disabled={giftOptions.length === 0} onChange={(event) => { const gift = giftOptions.find((item) => item.id === event.target.value); setRule({ ...rule, giftId: gift?.id ?? "", giftLabel: gift?.name ?? "" }); }}><option value="">{giftOptions.length === 0 ? "Hubungkan LIVE untuk memuat daftar gift" : "Pilih jenis gift"}</option>{giftOptions.map((gift) => <option key={gift.id} value={gift.id}>{gift.name}{gift.diamondCount > 0 ? ` · ${gift.diamondCount} koin` : ""}</option>)}</select><small className="field-help">Gift ID diisi otomatis dari katalog room LIVE.</small></label>
      <fieldset><legend>Keybind</legend><div className="chord-builder"><label>Modifier<select value={rule.keys.length > 1 ? rule.keys[0] : ""} onChange={(event) => setRule({ ...rule, keys: event.target.value ? [event.target.value, rule.keys.at(-1) ?? "Space"] : [rule.keys.at(-1) ?? "Space"] })}><option value="">Tanpa modifier</option><option value="ControlLeft">Ctrl kiri</option><option value="ShiftLeft">Shift kiri</option><option value="AltLeft">Alt kiri</option></select></label><span>+</span><label>Tombol<select value={rule.keys.at(-1)} onChange={(event) => setRule({ ...rule, keys: rule.keys.length > 1 ? [rule.keys[0], event.target.value] : [event.target.value] })}>{KEY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="key-preview">{rule.keys.map((key) => <kbd key={key}>{key.replace("Left", "").replace("Key", "")}</kbd>)}</div></div></fieldset>
      <div className="field-grid-three"><label>Durasi tekan <span>ms</span><input type="number" min="10" max="5000" value={rule.holdMs} onChange={(event) => setNumber("holdMs", event.target.value)} /></label><label>Cooldown <span>ms</span><input type="number" min="0" max="600000" value={rule.cooldownMs} onChange={(event) => setNumber("cooldownMs", event.target.value)} /></label><label>Prioritas <span>0–100</span><input type="number" min="0" max="100" value={rule.priority} onChange={(event) => setNumber("priority", event.target.value)} /></label></div>
      <fieldset><legend>Perilaku pengulangan</legend><div className="repeat-options">{(["once", "per_unit", "fixed"] as RepeatMode[]).map((mode) => <label className={rule.repeatMode === mode ? "selected" : ""} key={mode}><input type="radio" name="repeat" value={mode} checked={rule.repeatMode === mode} onChange={() => setRule({ ...rule, repeatMode: mode })} /><strong>{repeatLabel(mode)}</strong><small>{mode === "once" ? "Satu input per gift final" : mode === "per_unit" ? "Mengikuti jumlah streak" : "Jumlah tetap per gift"}</small></label>)}</div></fieldset>
      <div className="field-grid-three"><label>Jumlah tetap<input type="number" min="1" max="50" value={rule.fixedCount} disabled={rule.repeatMode !== "fixed"} onChange={(event) => setNumber("fixedCount", event.target.value)} /></label><label>Batas repeat<input type="number" min="1" max="50" value={rule.maxRepeats} onChange={(event) => setNumber("maxRepeats", event.target.value)} /></label><label>Jeda repeat <span>ms</span><input type="number" min="50" max="5000" value={rule.repeatGapMs} onChange={(event) => setNumber("repeatGapMs", event.target.value)} /></label></div>
      <footer><button type="button" className="button secondary" onClick={onClose}>Batal edit</button><button className="button primary">Terapkan aturan</button></footer>
    </form>
  </div>;
}

function MockConsole({ rules, onEmit }: { rules: Rule[]; onEmit: (giftId: string, count: number, streak: boolean) => void }) {
  const [giftId, setGiftId] = useState(rules[0]?.giftId ?? "5655");
  const [count, setCount] = useState(1);
  const [streak, setStreak] = useState(false);
  return <section className="mock-console"><div><p className="eyebrow">SIMULATION INPUT</p><h2>Kirim gift uji</h2></div><label>Gift ID<select value={giftId} onChange={(event) => setGiftId(event.target.value)}>{rules.filter((rule) => rule.giftId).map((rule) => <option key={rule.id} value={rule.giftId}>{rule.giftLabel || rule.giftId} · {rule.giftId}</option>)}</select></label><label>Jumlah<input type="number" min="1" max="50" value={count} onChange={(event) => setCount(Number(event.target.value))} /></label><label className="checkbox-inline"><input type="checkbox" checked={streak} onChange={(event) => setStreak(event.target.checked)} /> Gift streak</label><button className="button primary" onClick={() => onEmit(giftId, count, streak)} disabled={!giftId}>Kirim gift uji</button></section>;
}

function repeatLabel(mode: RepeatMode) {
  return mode === "once" ? "Sekali" : mode === "per_unit" ? "Per unit" : "Jumlah tetap";
}
