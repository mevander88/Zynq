import { FormEvent, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const sameConfig = (left: AppConfig, right: AppConfig) => JSON.stringify(left) === JSON.stringify(right);

function InlineError({ message, onClose }: { message?: string; onClose: () => void }) {
  if (!message) return null;
  return <div className="inline-error" role="alert"><span>{message}</span><button type="button" onClick={onClose} aria-label="Tutup pesan error">×</button></div>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(demoSnapshot);
  const [draft, setDraftState] = useState<AppConfig>(demoSnapshot.config);
  const [mockMode, setMockMode] = useState(true);
  const [targets, setTargets] = useState<TargetWindow[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [remoteConfigPending, setRemoteConfigPending] = useState<AppConfig | null>(null);
  const [showLogs, setShowLogs] = useState(true);
  const savedConfigRef = useRef<AppConfig>(demoSnapshot.config);
  const draftRef = useRef<AppConfig>(demoSnapshot.config);
  const latestRevisionRef = useRef(0);
  const setDraft = useCallback((update: SetStateAction<AppConfig>) => {
    setDraftState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      draftRef.current = next;
      return next;
    });
  }, []);

  const applySnapshot = useCallback((next: AppSnapshot, forceConfig = false) => {
    if (next.revision < latestRevisionRef.current) return;
    latestRevisionRef.current = next.revision;
    setSnapshot(next);
    const current = draftRef.current;
    const previousSaved = savedConfigRef.current;
    const hasLocalDraft = !sameConfig(current, previousSaved);
    const savedChanged = !sameConfig(previousSaved, next.config);
    savedConfigRef.current = structuredClone(next.config);
    if (forceConfig || !hasLocalDraft) {
      setRemoteConfigPending(null);
      setDraft(structuredClone(next.config));
    } else if (savedChanged && !sameConfig(current, next.config)) {
      setRemoteConfigPending(structuredClone(next.config));
    }
  }, [setDraft]);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void listenSnapshot((next) => {
      if (!live) return;
      applySnapshot(next);
    }).then((fn) => { unlisten = fn; });
    void getSnapshot().then((next) => {
      if (!live) return;
      applySnapshot(next);
      setMockMode(next.mockMode);
    });
    return () => { live = false; unlisten?.(); };
  }, [applySnapshot]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setActionErrors((current) => { const next = { ...current }; delete next[name]; return next; });
    try { await action(); }
    catch (error) { setActionErrors((current) => ({ ...current, [name]: errorText(error) })); }
    finally { setBusy(null); }
  };

  const clearError = (name: string) => setActionErrors((current) => { const next = { ...current }; delete next[name]; return next; });

  const connected = snapshot.connection === "connected";
  const armed = snapshot.automation === "armed";
  const emergency = snapshot.automation === "emergency_latched";
  const configDirty = !sameConfig(draft, snapshot.config);
  const canStart = connected && !!snapshot.selectedTarget && !configDirty && !emergency && snapshot.automation === "disarmed";

  const connectionLabel: Record<string, string> = {
    idle: "Belum terhubung", starting: "Menyiapkan connector", connecting: "Menghubungkan",
    connected: "LIVE terhubung", reconnecting: "Menghubungkan ulang", offline: "LIVE offline",
    stopping: "Memutus koneksi", error: "Koneksi bermasalah"
  };
  const automationLabel: Record<string, string> = {
    disarmed: "Aman", arming: "Bersiap", armed: "Aktif", emergency_latched: "Darurat terkunci", faulted: "Bermasalah"
  };

  const visibleLogs = useMemo(() => snapshot.logs.slice(-80).reverse(), [snapshot.logs]);
  const canAddRule = snapshot.giftCatalog.length > 0;
  const catalogMessage = snapshot.giftCatalogStatus === "loading" ? "Memuat daftar gift…"
    : snapshot.giftCatalogStatus === "ready" ? `${snapshot.giftCatalog.length} jenis gift siap dipilih.`
      : snapshot.giftCatalogStatus === "empty" ? "LIVE ini tidak mengembalikan daftar gift."
        : snapshot.giftCatalogStatus === "error" ? "Daftar gift gagal dimuat."
          : "Hubungkan LIVE atau simulator untuk memuat jenis gift.";

  const connect = (event: FormEvent) => {
    event.preventDefault();
    void run("connect", () => commands.connect(draft.live.username, mockMode));
  };

  const save = () => void run("save", async () => {
    const saved = await commands.saveConfig(structuredClone(draft));
    applySnapshot(saved, true);
  });

  const triggerEmergency = () => {
    clearError("master");
    void commands.emergency().catch((error) => setActionErrors((current) => ({ ...current, master: errorText(error) })));
  };

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
          <span><StatusDot active={armed} warning={emergency} />{emergency ? "Darurat terkunci" : armed ? "Otomasi aktif" : "Otomasi aman"}</span>
          <span className="shortcut-label">DARURAT <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>F10</kbd></span>
        </div>
      </header>

      <main id="main-content">
        <section className="command-deck" aria-labelledby="desk-title">
          <div className="desk-heading">
            <p className="eyebrow">SESI / {snapshot.mockMode ? "SIMULASI" : "LIVE"}</p>
            <h1 id="desk-title">Gift masuk.<br />Aksi <em>terkendali.</em></h1>
            <p>Hubungkan satu LIVE, pilih target foreground, lalu aktifkan aturan saat Anda siap.</p>
          </div>
          <div className="master-controls">
            <div className="master-readout">
              <span className="readout-label">STATUS UTAMA</span>
              <strong>{automationLabel[snapshot.automation].toUpperCase()}</strong>
              <small>{snapshot.statusMessage}</small>
            </div>
            <div className="master-actions">
              {emergency ? (
                <button className="button reset-button" onClick={() => void run("reset", commands.resetEmergency)} disabled={!!busy}>Reset emergency</button>
              ) : armed ? (
                <button className="button stop-button" onClick={() => void run("stop", commands.stop)} disabled={!!busy}>Hentikan otomasi</button>
              ) : (
                <button className="button start-button" onClick={() => void run("start", commands.start)} disabled={!canStart || !!busy}>Mulai otomasi</button>
              )}
              <button className="emergency-button" onClick={triggerEmergency} disabled={emergency}>
                <span>HENTIKAN</span><strong>DARURAT</strong>
              </button>
            </div>
            {!canStart && !armed && !emergency && <p className="start-hint">{!connected ? "Hubungkan LIVE terlebih dahulu." : !snapshot.selectedTarget ? "Pilih jendela target." : configDirty ? "Simpan perubahan konfigurasi." : "Otomasi belum siap."}</p>}
            <InlineError message={actionErrors.master || actionErrors.start || actionErrors.stop || actionErrors.reset} onClose={() => { clearError("master"); clearError("start"); clearError("stop"); clearError("reset"); }} />
          </div>
        </section>

        {snapshot.configLoadError && <div className="recovery-banner" role="alert"><div><strong>Konfigurasi lama tidak dapat dibaca.</strong><span>Pengaturan default sedang digunakan. File lama tetap dipertahankan sebagai backup saat Anda menyimpan konfigurasi baru.</span><small>{snapshot.configLoadError}</small></div><button className="button primary" onClick={save} disabled={busy === "save"}>{busy === "save" ? "Menyimpan…" : "Simpan konfigurasi baru"}</button></div>}

        <section className="setup-grid" aria-label="Pengaturan sesi">
          <article className="setup-panel connection-panel">
            <div className="section-heading"><span className="section-number">01</span><div><Icon name="signal" /><h2>Koneksi LIVE</h2></div></div>
            <form onSubmit={connect} className="connection-form">
              <label htmlFor="username">Username TikTok</label>
              <div className="input-affix"><span>@</span><input id="username" value={draft.live.username} onChange={(event) => setDraft((current) => ({ ...current, live: { username: event.target.value.replace(/^@/, "") } }))} placeholder="nama_streamer" disabled={connected} autoComplete="off" maxLength={64} /></div>
              <label className="switch-row"><input type="checkbox" checked={mockMode} onChange={(event) => setMockMode(event.target.checked)} disabled={connected} /><span className="switch" /><span><strong>Mode simulasi</strong><small>Uji alur tanpa terhubung ke TikTok</small></span></label>
              <div className="inline-actions">
                {!connected ? <button className="button primary" disabled={busy === "connect" || (!mockMode && !draft.live.username.trim())}>{busy === "connect" ? "Menghubungkan…" : "Hubungkan LIVE"}</button> : <button type="button" className="button secondary" onClick={() => void run("disconnect", commands.disconnect)} disabled={busy === "disconnect"}>{busy === "disconnect" ? "Memutuskan…" : "Putuskan koneksi"}</button>}
                <span className={`state-chip state-${snapshot.connection}`}><StatusDot active={connected} />{connectionLabel[snapshot.connection]}</span>
              </div>
              <InlineError message={actionErrors.connect || actionErrors.disconnect} onClose={() => { clearError("connect"); clearError("disconnect"); }} />
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
            <InlineError message={actionErrors.targets || actionErrors.target} onClose={() => { clearError("targets"); clearError("target"); }} />
            <div className="target-list">
              {targets.length === 0 && !snapshot.selectedTarget && <div className="empty-state"><span>Belum ada target</span><small>Pindai jendela desktop, lalu pilih aplikasi atau game.</small></div>}
              {snapshot.selectedTarget && !targets.some((item) => item.hwnd === snapshot.selectedTarget?.hwnd) && <TargetButton target={snapshot.selectedTarget} selected onSelect={() => undefined} />}
              {targets.map((target) => <TargetButton key={String(target.hwnd)} target={target} selected={snapshot.selectedTarget?.hwnd === target.hwnd} onSelect={() => void run("target", () => commands.selectTarget(target.hwnd))} />)}
            </div>
          </article>
        </section>

        <section className="rules-section" aria-labelledby="rules-title">
          <div className="section-header-wide">
            <div><span className="section-number">03</span><p className="eyebrow">TABEL RUTE</p><h2 id="rules-title">Gift → Keybind</h2></div>
            <div className="rules-actions"><span>{draft.rules.filter((rule) => rule.enabled).length} aktif / {draft.rules.length} aturan</span><button className="button primary icon-label" onClick={() => setEditing(newRule())} disabled={!canAddRule}><Icon name="plus" />Tambah aturan</button></div>
          </div>

          <div className={`catalog-status catalog-${snapshot.giftCatalogStatus}`} role="status"><div><strong>Katalog gift</strong><span>{catalogMessage}</span>{snapshot.giftCatalogError && <small>{snapshot.giftCatalogError}</small>}</div>{connected && (snapshot.giftCatalogStatus === "error" || snapshot.giftCatalogStatus === "empty") && <button className="button secondary icon-label" onClick={() => void run("catalog", commands.refreshGiftCatalog)} disabled={busy === "catalog"}><Icon name="refresh" />{busy === "catalog" ? "Memuat…" : "Coba lagi"}</button>}</div>
          <InlineError message={actionErrors.catalog} onClose={() => clearError("catalog")} />

          <div className="rules-table" aria-label="Daftar aturan gift">
            <div className="rule-row rule-header"><span>Status</span><span>Gift</span><span>Keybind</span><span>Durasi</span><span>Pengulangan</span><span>Prioritas</span><span>Aksi</span></div>
            {draft.rules.length === 0 && <div className="rules-empty"><Icon name="gift" /><strong>Belum ada rute gift</strong><span>{canAddRule ? "Pilih jenis gift dan tombol yang akan dijalankan." : "Hubungkan LIVE atau simulator agar jenis gift dapat dipilih."}</span><button className="button primary" onClick={() => setEditing(newRule())} disabled={!canAddRule}>Buat aturan pertama</button></div>}
            {draft.rules.map((rule) => (
              <div className={`rule-row ${!rule.enabled ? "is-disabled" : ""}`} key={rule.id}>
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
          {remoteConfigPending && <div className="draft-conflict" role="alert"><div><strong>Konfigurasi tersimpan berubah.</strong><span>Draft Anda tetap dipertahankan. Muat ulang hanya jika ingin membuang perubahan lokal.</span></div><button className="button secondary" onClick={() => { setDraft(structuredClone(remoteConfigPending)); setRemoteConfigPending(null); }}>Muat ulang</button></div>}
          <div className="save-bar"><span>{configDirty ? "Perubahan konfigurasi belum disimpan" : `Konfigurasi revisi ${snapshot.config.revision} tersimpan`}</span><button className="button primary" onClick={save} disabled={!configDirty || busy === "save"}>{busy === "save" ? "Menyimpan…" : "Simpan konfigurasi"}</button></div>
          <InlineError message={actionErrors.save} onClose={() => clearError("save")} />
        </section>

        {snapshot.mockMode && connected && <><MockConsole rules={draft.rules} busy={busy === "mock"} onEmit={(giftId, count, streak) => void run("mock", () => commands.emitMockGift(giftId, count, streak))} /><InlineError message={actionErrors.mock} onClose={() => clearError("mock")} /></>}

        <section className="telemetry" aria-labelledby="telemetry-title">
          <div className="telemetry-stats">
            <div><span>ANTREAN</span><strong>{snapshot.queueDepth.toString().padStart(2, "0")}</strong></div>
            <div><span>INPUT TERKIRIM</span><strong>{snapshot.inputCount.toString().padStart(2, "0")}</strong></div>
            <div><span>DILEWATI</span><strong>{snapshot.droppedCount.toString().padStart(2, "0")}</strong></div>
          </div>
          <div className="log-panel">
            <button className="log-heading" onClick={() => setShowLogs((value) => !value)} aria-expanded={showLogs}><span><Icon name="log" /><strong id="telemetry-title">Log aktivitas</strong></span><small>{showLogs ? "Tutup" : "Buka"}</small></button>
            {showLogs && <div className="log-stream" role="log" aria-live="polite" aria-relevant="additions text">{visibleLogs.length === 0 ? <div className="empty-log">Aktivitas koneksi, gift, dan input akan muncul di sini.</div> : visibleLogs.map((log) => <div className={`log-line level-${log.level}`} key={log.id}><time>{new Date(/^\d+$/.test(log.timestamp) ? Number(log.timestamp) : log.timestamp).toLocaleTimeString("id-ID", { hour12: false })}</time><span className="log-level">{log.level}</span><div><strong>{log.message}</strong>{log.detail && <small>{log.detail}</small>}</div></div>)}</div>}
          </div>
        </section>
      </main>

      <footer><span>ZYNQ / KONTROLER DESKTOP LOKAL</span><span>Input dikirim ke Windows; penerimaan oleh game tidak dijamin.</span></footer>
      {editing && <RuleEditor rule={editing} gifts={snapshot.giftCatalog} isNew={!draft.rules.some((rule) => rule.id === editing.id)} onSave={saveRule} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TargetButton({ target, selected, onSelect }: { target: TargetWindow; selected: boolean; onSelect: () => void }) {
  return <button className={`target-item ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}><span className="app-initial">{target.processName.slice(0, 1).toUpperCase()}</span><span><strong>{target.title}</strong><small>{target.processName} · PID {target.pid}</small></span><span className="target-state">{target.foreground ? "Foreground" : selected ? "Dipilih" : "Pilih"}</span></button>;
}

function RuleEditor({ rule: initial, gifts, isNew, onSave, onClose }: { rule: Rule; gifts: GiftCatalogItem[]; isNew: boolean; onSave: (rule: Rule) => void; onClose: () => void }) {
  const [rule, setRule] = useState(initial);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const giftOptions = useMemo(() => {
    if (!rule.giftId || gifts.some((gift) => gift.id === rule.giftId)) return gifts;
    return [{ id: rule.giftId, name: rule.giftLabel || `Gift ${rule.giftId}`, diamondCount: 0 }, ...gifts];
  }, [gifts, rule.giftId, rule.giftLabel]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const form = formRef.current;
    const focusable = () => Array.from(form?.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)") ?? []).filter((element) => element.offsetParent !== null);
    (form?.querySelector<HTMLElement>("select:not(:disabled)") ?? focusable()[0])?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) { event.preventDefault(); return; }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{1,32}$/.test(rule.giftId) || rule.giftId === "0") { setError("Pilih jenis gift sebelum menerapkan aturan."); return; }
    if (rule.keys.length === 0) { setError("Pilih setidaknya satu tombol."); return; }
    onSave(rule);
  };
  const setNumber = (field: keyof Rule, value: string) => setRule((current) => ({ ...current, [field]: Number(value) }));
  return <div className="editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={formRef} className="rule-editor" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="editor-title" aria-describedby={error ? "editor-error" : undefined}>
      <header><div><p className="eyebrow">EDITOR ATURAN</p><h2 id="editor-title">{isNew ? "Tambah rute gift" : "Edit rute gift"}</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Tutup editor">×</button></header>
      {error && <p id="editor-error" className="field-error" role="alert">{error}</p>}
      <label>Jenis gift<select value={rule.giftId} disabled={giftOptions.length === 0} required aria-describedby="gift-help" onChange={(event) => { const gift = giftOptions.find((item) => item.id === event.target.value); setRule({ ...rule, giftId: gift?.id ?? "", giftLabel: gift?.name ?? "" }); setError(""); }}><option value="">{giftOptions.length === 0 ? "Daftar gift belum tersedia" : "Pilih jenis gift"}</option>{giftOptions.map((gift) => <option key={gift.id} value={gift.id}>{gift.name}{gift.diamondCount > 0 ? ` · ${gift.diamondCount} koin` : ""}</option>)}</select><small id="gift-help" className="field-help">Nama dan ID diambil dari katalog room LIVE.</small></label>
      <fieldset><legend>Keybind</legend><div className="chord-builder"><label>Modifier<select value={rule.keys.length > 1 ? rule.keys[0] : ""} onChange={(event) => setRule({ ...rule, keys: event.target.value ? [event.target.value, rule.keys.at(-1) ?? "Space"] : [rule.keys.at(-1) ?? "Space"] })}><option value="">Tanpa modifier</option><option value="ControlLeft">Ctrl kiri</option><option value="ShiftLeft">Shift kiri</option><option value="AltLeft">Alt kiri</option></select></label><span>+</span><label>Tombol<select value={rule.keys.at(-1)} onChange={(event) => setRule({ ...rule, keys: rule.keys.length > 1 ? [rule.keys[0], event.target.value] : [event.target.value] })}>{KEY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="key-preview">{rule.keys.map((key) => <kbd key={key}>{key.replace("Left", "").replace("Key", "")}</kbd>)}</div></div></fieldset>
      <div className="field-grid-three"><label>Durasi tekan <span>ms</span><input type="number" min="10" max="5000" value={rule.holdMs} onChange={(event) => setNumber("holdMs", event.target.value)} /></label><label>Cooldown <span>ms</span><input type="number" min="0" max="600000" value={rule.cooldownMs} onChange={(event) => setNumber("cooldownMs", event.target.value)} /></label><label>Prioritas <span>0–100</span><input type="number" min="0" max="100" value={rule.priority} onChange={(event) => setNumber("priority", event.target.value)} /></label></div>
      <fieldset><legend>Perilaku pengulangan</legend><div className="repeat-options">{(["once", "per_unit", "fixed"] as RepeatMode[]).map((mode) => <label className={rule.repeatMode === mode ? "selected" : ""} key={mode}><input type="radio" name="repeat" value={mode} checked={rule.repeatMode === mode} onChange={() => setRule({ ...rule, repeatMode: mode })} /><strong>{repeatLabel(mode)}</strong><small>{mode === "once" ? "Satu input per gift final" : mode === "per_unit" ? "Mengikuti jumlah streak" : "Jumlah tetap per gift"}</small></label>)}</div></fieldset>
      <div className="field-grid-three"><label>Jumlah tetap<input type="number" min="1" max="50" value={rule.fixedCount} disabled={rule.repeatMode !== "fixed"} onChange={(event) => setNumber("fixedCount", event.target.value)} /></label><label>Batas repeat<input type="number" min="1" max="50" value={rule.maxRepeats} onChange={(event) => setNumber("maxRepeats", event.target.value)} /></label><label>Jeda repeat <span>ms</span><input type="number" min="50" max="5000" value={rule.repeatGapMs} onChange={(event) => setNumber("repeatGapMs", event.target.value)} /></label></div>
      <footer><button type="button" className="button secondary" onClick={onClose}>Batal edit</button><button className="button primary">Terapkan aturan</button></footer>
    </form>
  </div>;
}

function MockConsole({ rules, busy, onEmit }: { rules: Rule[]; busy: boolean; onEmit: (giftId: string, count: number, streak: boolean) => void }) {
  const availableRules = useMemo(() => rules.filter((rule) => rule.enabled && rule.giftId), [rules]);
  const [giftId, setGiftId] = useState(availableRules[0]?.giftId ?? "");
  const [count, setCount] = useState(1);
  const [streak, setStreak] = useState(false);
  useEffect(() => { if (!availableRules.some((rule) => rule.giftId === giftId)) setGiftId(availableRules[0]?.giftId ?? ""); }, [availableRules, giftId]);
  return <section className="mock-console"><div><p className="eyebrow">INPUT SIMULASI</p><h2>Kirim gift uji</h2></div>{availableRules.length === 0 ? <p className="mock-empty">Aktifkan dan simpan setidaknya satu aturan untuk mengirim gift uji.</p> : <><label>Jenis gift<select value={giftId} onChange={(event) => setGiftId(event.target.value)}>{availableRules.map((rule) => <option key={rule.id} value={rule.giftId}>{rule.giftLabel || `Gift ${rule.giftId}`}</option>)}</select></label><label>Jumlah<input type="number" min="1" max="50" value={count} onChange={(event) => setCount(Number(event.target.value))} /></label><label className="checkbox-inline"><input type="checkbox" checked={streak} onChange={(event) => setStreak(event.target.checked)} /> Gift beruntun</label><button className="button primary" onClick={() => onEmit(giftId, count, streak)} disabled={!giftId || busy}>{busy ? "Mengirim…" : "Kirim gift uji"}</button></>}</section>;
}

function repeatLabel(mode: RepeatMode) {
  return mode === "once" ? "Sekali" : mode === "per_unit" ? "Per unit" : "Jumlah tetap";
}
