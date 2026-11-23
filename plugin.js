export const inject = ["agents", "host", "react", "pages", "panels"];

// New process/session for each turn; Buzz reconstructs conversation context.
// No secrets, transcripts or MCP credentials are persisted by this plugin.
export function apply(ctx) {
  const { agents, host, react: R } = ctx;
  if (!agents.harness || !host.spawn || !host.serveMcp || !host.resolveDirectory || !host.readFile)
    throw new Error("Esta versão do Buzz não oferece o contrato de harness/MCP necessário.");
  const h = R.createElement;
  const active = new Map();
  const approvals = new Map();
  const listeners = new Set();
  const catalogs = new Map();
  const probes = new Set();
  const permissionModes = {
    auto: "Perguntar (ações não liberadas pelo Devin)",
    "accept-edits": "Permitir edições na pasta de trabalho",
    smart: "Smart: avaliar ações automaticamente",
    dangerous: "Bypass: permitir todas as ferramentas",
  };
  const busyModes = {
    queue: "Fila: recusar enquanto o turno executa",
    steer: "Steer: incorporar no turno em execução",
  };
  let disposed = false;
  let approvalId = 0;
  const emit = () => { for (const fn of listeners) fn(); };
  const config = (value = {}) => ({
    model: typeof value.model === "string" ? value.model : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "~/.buzz",
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    permissionMode: Object.hasOwn(permissionModes, value.permissionMode) ? value.permissionMode : "auto",
    busyMode: Object.hasOwn(busyModes, value.busyMode) ? value.busyMode : "queue",
  });
  async function catalog(cwdValue) {
    const cwd = await host.resolveDirectory(cwdValue);
    const cached = catalogs.get(cwd);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = (async () => {
      let proc, buffer = "", next = 0, stopped = false;
      const pending = new Map();
      const fail = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
      const stop = () => { stopped = true; fail(new Error("Consulta de modelos encerrada.")); return proc?.kill(); };
      probes.add(stop);
      const timer = setTimeout(stop, 15000);
      try {
        if (disposed || stopped) throw new Error("Consulta encerrada.");
        proc = await host.spawn("devin", { env: { DEVIN_PERMISSION_MODE: "auto", DEVIN_REFUSAL_FALLBACK: null }, cwd,
          onStdout: chunk => {
            buffer += chunk;
            if (buffer.length > 4 * 1024 * 1024) { void stop(); return; }
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                if (!msg.method && pending.has(msg.id)) {
                  const p = pending.get(msg.id); pending.delete(msg.id);
                  msg.error ? p.reject(new Error(msg.error.message || "Erro ACP")) : p.resolve(msg.result);
                } else if (msg.method && msg.id !== undefined) {
                  void proc.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
                    ...(msg.method === "session/request_permission" ? { result: { outcome: { outcome: "cancelled" } } }
                      : { error: { code: -32601, message: "Consulta sem ferramentas" } }) }) + "\n").catch(fail);
                }
              } catch (error) { fail(error); }
            }
          } });
        proc.exited.then(() => fail(new Error("Devin encerrou a consulta.")), fail);
        if (disposed || stopped) throw new Error("Consulta encerrada.");
        const rpc = (method, params) => new Promise((resolve, reject) => {
          const id = ++next; pending.set(id, { resolve, reject });
          proc.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n").catch(fail);
        });
        await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "buzz-devin-models", version: "1" } });
        const session = await rpc("session/new", { cwd, mcpServers: [] });
        const field = session.configOptions?.find(o => o.category === "model" && o.type === "select");
        const rows = field?.options?.filter(o => typeof o.value === "string").map(o => ({ id: o.value, label: o.name || o.value, efforts: [] }))
          || session.models?.availableModels?.map(o => ({ id: o.modelId, label: o.name || o.modelId, efforts: [] })) || [];
        if (!rows.length) throw new Error("Devin não anunciou modelos. Verifique a instalação e tente novamente.");
        return { current: field?.currentValue || session.models?.currentModelId || "", models: rows };
      } finally { clearTimeout(timer); probes.delete(stop); await proc?.kill(); }
    })();
    catalogs.set(cwd, { expires: Date.now() + 60000, promise });
    try { return await promise; } catch (error) { if (catalogs.get(cwd)?.promise === promise) catalogs.delete(cwd); throw error; }
  }
  // The host's design-system classes are global, so plugin markup can reuse
  // the same chrome the bundled harnesses use: settings groups, preference
  // rows and the compact select pill. A native <select> wears the pill;
  // the chevron is an overlay since appearance:none removes the native one.
  function caret(size = 14) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
      className: "buzz-dropdown-chevron", "aria-hidden": "true" }, h("path", { d: "M6 9l6 6l6 -6" }));
  }
  const GLYPHS = {
    back: "M19 12H5m0 0 7-7m-7 7 7 7",
    refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
    check: "m5 12 5 5 9-10",
    x: "M6 6l12 12M18 6 6 18",
    bulb: "M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3Zm-2 16h4m-3 2h2",
    terminal: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 5 3 3-3 3m5 0h4",
    eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    pencil: "m14 6 4 4L8 20H4v-4L14 6Zm2-2 4 4",
    search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM21 21l-5.6-5.6",
    globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z",
    list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
    shield: "M12 3 5 5.5v5c0 4.8 3 8.4 7 10.5 4-2.1 7-5.7 7-10.5v-5L12 3Z",
    trash: "M4 7h16M10 7V5h4v2m-8 0 1 13h10l1-13",
    move: "M9 4h6v4H9zM4 9h4v6H4zM16 9h4v6h-4zM9 16h6v4H9z",
    chat: "M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.8-.3-4-.9L3 21l1.6-4.9A8.5 8.5 0 1 1 21 12Z",
    wrench: "M14.7 6.3a4.6 4.6 0 0 0-6.3 5.4L3 18l3 3 5.7-5.7a4.6 4.6 0 0 0 6-6.1l-3 3-2.5-2.5 2.5-3.4Z",
  };
  function icon(name, size = 16) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": "true", style: { flexShrink: 0 } }, h("path", { d: GLYPHS[name] ?? GLYPHS.wrench }));
  }
  const KIND_ICON = { execute: "terminal", read: "eye", edit: "pencil", delete: "trash",
    move: "move", search: "search", fetch: "globe", think: "bulb" };
  const KIND_ACTION = { read: "Ler", edit: "Editar", delete: "Apagar", move: "Mover",
    search: "Buscar", execute: "Executar", think: "Pensar", fetch: "Web",
    switch_mode: "Modo", other: "Chamar" };
  function PillSelect({ label, value, options, disabled, onChange, appearance = "outlined", shape = "control" }) {
    return h("div", { "data-buzz-ui": "", className: "buzz-select", "data-variant": "compact",
      "data-appearance": appearance, style: { position: "relative", minWidth: 0, maxWidth: "100%" } },
      h("select", {
        "aria-label": label, value, disabled,
        className: "buzz-button",
        "data-variant": appearance === "outlined" ? "outline" : appearance,
        "data-size": appearance === "glass-ghost" ? "xs" : "sm",
        "data-button-shape": shape,
        style: {
          appearance: "none", WebkitAppearance: "none", width: "100%", maxWidth: "100%",
          paddingInlineEnd: "calc(var(--space-5) + var(--space-2))", textAlign: "start",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        },
        onChange: e => onChange(e.target.value),
      }, options.map(o => h("option", { key: o.value, value: o.value }, o.label))),
      h("span", { "aria-hidden": "true", style: { position: "absolute", insetInlineEnd: "var(--space-3)",
        top: "50%", transform: "translateY(-50%)", pointerEvents: "none", display: "flex", alignItems: "center" } },
        caret()));
  }
  function PrefRow({ title, description, children }) {
    return h("div", { "data-buzz-ui": "", className: "buzz-preference-row" },
      h("div", { className: "buzz-preference-row-content" },
        h("div", { className: "buzz-preference-row-label" }, title),
        description ? h("span", { className: "buzz-preference-row-description" }, description) : null),
      h("div", { className: "buzz-preference-row-trailing" }, children));
  }
  function Field({ label, description, htmlFor, children }) {
    return h("div", { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { className: "buzz-field-label", htmlFor }, label), children,
      description ? h("p", { className: "buzz-field-description", style: { margin: 0 } }, description) : null);
  }
  function permissionHint(mode) {
    return mode === "dangerous" ? "Bypass permite executar comandos e alterar arquivos sem revisão humana. Políticas da organização ainda podem exigir aprovação."
      : mode === "smart" ? "O Devin usa um modelo para liberar ações consideradas seguras. As demais pedem sua aprovação na página Devin."
      : mode === "accept-edits" ? "Edições na pasta de trabalho são liberadas; demais ações pedem sua aprovação na página Devin."
      : "Pedidos de aprovação aparecem na página Devin. Usa seu login local; cada turno abre uma sessão com o histórico do Buzz.";
  }
  function busyHint(mode) {
    return mode === "steer"
      ? "Mensagens que chegam durante um turno são injetadas na sessão em execução e o Devin incorpora o novo pedido na mesma resposta."
      : "Mensagens que chegam durante um turno aguardam o fim da execução; um segundo turno simultâneo é recusado.";
  }
  // The catalog select Codex-style: just the pill, saving on each pick through
  // the host's own onChange. Loading and recovery stay with the field.
  function ModelChoices({ value, onChange, disabled, appearance, shape }) {
    const [offered, setOffered] = R.useState([]);
    const [state, setState] = R.useState("loading");
    const [retry, setRetry] = R.useState(0);
    R.useEffect(() => {
      let live = true; setState("loading");
      const timer = setTimeout(() => {
        catalog(value.cwd).then(result => { if (live) { setOffered(result.models); setState(""); } },
          () => { if (live) { setOffered([]); setState("error"); } });
      }, 300);
      return () => { live = false; clearTimeout(timer); };
    }, [value.cwd, retry]);
    const loading = state === "loading";
    const options = [
      { value: "", label: loading ? "Carregando modelos…" : "Padrão da conta Devin" },
      ...(value.model && !offered.some(o => o.id === value.model) ? [{ value: value.model, label: value.model }] : []),
      ...offered.map(o => ({ value: o.id, label: o.label })),
    ];
    return h("div", { style: { display: "contents" } },
      h("div", { style: { display: "flex", maxWidth: "100%", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: "var(--space-2)" } },
        h(PillSelect, { label: "Modelo", value: value.model, options, disabled: disabled || loading,
          appearance, shape, onChange: model => onChange({ ...value, model }) }),
        state === "error" && h("button", { type: "button", className: "buzz-button", "data-variant": "outline",
          "data-size": "sm", disabled, onClick: () => { catalogs.clear(); setRetry(n => n + 1); } }, "Tentar novamente")),
      state === "error" && h("span", { role: "alert", className: "text-body-sm text-danger" },
        "Não foi possível listar modelos. Confira o login e a pasta de trabalho."));
  }
  function Create(props) {
    const value = config(props.config);
    const onChange = props.onChange;
    const base = R.useId();
    return h("div", { style: { display: "grid", gap: "var(--space-4)" } },
      h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "rows" },
        h(PrefRow, { title: "Permissão", description: permissionHint(value.permissionMode) },
          h(PillSelect, { label: "Permissão", value: value.permissionMode, disabled: props.disabled,
            options: Object.entries(permissionModes).map(([id, label]) => ({ value: id, label })),
            onChange: permissionMode => onChange({ ...value, permissionMode }) })),
        h(PrefRow, { title: "Mensagem durante turno", description: busyHint(value.busyMode) },
          h(PillSelect, { label: "Mensagem durante turno", value: value.busyMode, disabled: props.disabled,
            options: Object.entries(busyModes).map(([id, label]) => ({ value: id, label })),
            onChange: busyMode => onChange({ ...value, busyMode }) }))),
      h(Field, { label: "Pasta de trabalho", htmlFor: `${base}-cwd` },
        h("input", { id: `${base}-cwd`, className: "buzz-input", value: value.cwd, disabled: props.disabled,
          placeholder: "~/.buzz", style: { width: "100%" }, onChange: e => onChange({ ...value, cwd: e.target.value }) })),
      h(Field, { label: "Instruções", htmlFor: `${base}-instructions` },
        h("textarea", { id: `${base}-instructions`, className: "buzz-textarea", "data-variant": "text",
          "data-surface": "inset", "data-appearance": "outlined", value: value.instructions, disabled: props.disabled,
          rows: 4, placeholder: "Ajude-me a planejar minha semana e priorizar tarefas.",
          style: { width: "100%" }, onChange: e => onChange({ ...value, instructions: e.target.value }) })));
  }
  function CreateModel(props) {
    return h(ModelChoices, { value: config(props.config), onChange: props.onChange, disabled: props.disabled,
      appearance: props.modelAppearance ?? "outlined", shape: "capsule" });
  }
  // Split settings: the host asks this component to render its identity part
  // (Harness/Modelo/Permissão + Instruções) or its runtime part (pasta +
  // management rows) depending on which tab is selected.
  function Settings({ agent, save, settingsHost, settingsSection, settingsContent }) {
    const [draft, setDraft] = R.useState(() => config(agent.config));
    const [state, setState] = R.useState("");
    const [busy, setBusy] = R.useState(false);
    const base = R.useId();
    R.useEffect(() => { setDraft(config(agent.config)); }, [agent.config]);
    const changed = JSON.stringify(draft) !== JSON.stringify(config(agent.config));
    return h("form", { style: { display: "grid", gap: "var(--space-4)", containerType: "inline-size" },
      onSubmit: e => {
        e.preventDefault();
        setBusy(true); setState("");
        void save({ ...agent.config, ...draft }).then(
          () => setState("Salvo."),
          () => setState("Não foi possível salvar. Confira a atividade do Buzz."),
        ).finally(() => setBusy(false));
      } },
      settingsSection !== "runtime" && h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "rows" },
        settingsHost?.typeControl?.(changed),
        h(PrefRow, { title: "Modelo" },
          h(ModelChoices, { value: draft, onChange: setDraft, disabled: busy, appearance: "outlined", shape: "control" })),
        h(PrefRow, { title: "Permissão", description: permissionHint(draft.permissionMode) },
          h(PillSelect, { label: "Permissão", value: draft.permissionMode, disabled: busy,
            options: Object.entries(permissionModes).map(([id, label]) => ({ value: id, label })),
            onChange: permissionMode => setDraft({ ...draft, permissionMode }) })),
        h(PrefRow, { title: "Mensagem durante turno", description: busyHint(draft.busyMode) },
          h(PillSelect, { label: "Mensagem durante turno", value: draft.busyMode, disabled: busy,
            options: Object.entries(busyModes).map(([id, label]) => ({ value: id, label })),
            onChange: busyMode => setDraft({ ...draft, busyMode }) }))),
      settingsSection !== "runtime" && h(Field, { label: "Instruções", htmlFor: `${base}-instructions` },
        h("textarea", { id: `${base}-instructions`, className: "buzz-textarea", "data-variant": "text",
          "data-surface": "inset", "data-appearance": "outlined", value: draft.instructions, disabled: busy,
          rows: 8, placeholder: "Ajude-me a planejar minha semana e priorizar tarefas.",
          style: { width: "100%" }, onChange: e => setDraft({ ...draft, instructions: e.target.value }) })),
      settingsSection !== "identity" && h(Field, { label: "Pasta de trabalho", htmlFor: `${base}-cwd`,
        description: "O Devin inicia nesse diretório usando seu login local. As ferramentas Buzz rodam dentro do app." },
        h("input", { id: `${base}-cwd`, className: "buzz-input", value: draft.cwd, disabled: busy,
          placeholder: "~/.buzz", style: { width: "100%" }, onChange: e => setDraft({ ...draft, cwd: e.target.value }) })),
      h("div", null, h("button", { type: "submit", className: "buzz-button", "data-variant": "prominent",
        disabled: busy || !changed }, busy ? "Salvando…" : "Salvar")),
      settingsSection !== "identity" && settingsContent,
      state ? h("p", { role: "status", style: { margin: 0 } }, state) : null);
  }
  const HISTORY_LIMIT = 12;
  const histories = new Map();
  const historyLoaded = new Set();
  const activityKey = key => `devin.activity.${key}`;
  const activityRows = agentKey => [...(histories.get(agentKey)?.values() ?? [])];
  async function ensureHistory(agentKey) {
    if (historyLoaded.has(agentKey)) return;
    historyLoaded.add(agentKey);
    try {
      const raw = await agents.storage.get(activityKey(agentKey));
      const rows = Array.isArray(raw && JSON.parse(raw)) ? JSON.parse(raw) : [];
      if (!histories.has(agentKey)) histories.set(agentKey, new Map(rows.map(row => [row.key, row])));
    } catch { if (!histories.has(agentKey)) histories.set(agentKey, new Map()); }
    emit();
  }
  function recordActivity(agentKey, conversation, status, detail) {
    if (!historyLoaded.has(agentKey)) {
      void ensureHistory(agentKey).then(() => recordActivity(agentKey, conversation, status, detail));
      return;
    }
    let rows = histories.get(agentKey);
    if (!rows) histories.set(agentKey, rows = new Map());
    const previous = rows.get(conversation.key) ?? {};
    rows.set(conversation.key, {
      key: conversation.key, channel: conversation.channel,
      ...(conversation.root ? { root: conversation.root } : {}),
      where: conversation.where, at: Date.now(), status,
      detail: detail ?? previous.detail,
    });
    while (rows.size > HISTORY_LIMIT) rows.delete(rows.keys().next().value);
    void agents.storage.set(activityKey(agentKey), JSON.stringify([...rows.values()])).catch(() => {});
    emit();
  }
  // Session transcripts. The host leaves transcript reads to each harness type;
  // Devin spawns a fresh ACP process per turn and keeps no session files Buzz
  // can read, so the plugin records each turn's session/update stream itself
  // and renders it in the Activity tab, mirroring the bundled Codex transcript.
  const TURN_LIMIT = 3;
  const ITEM_LIMIT = 300;
  const TEXT_LIMIT = 16000;
  const transcripts = new Map();
  const transcriptLoaded = new Set();
  const transcriptKey = key => `devin.transcript.${key}`;
  const transcriptTurns = (agentKey, convKey) => transcripts.get(agentKey)?.get(convKey) ?? [];
  async function ensureTranscripts(agentKey) {
    if (transcriptLoaded.has(agentKey)) return;
    transcriptLoaded.add(agentKey);
    try {
      const raw = await agents.storage.get(transcriptKey(agentKey));
      const stored = raw && JSON.parse(raw);
      if (stored && typeof stored === "object") {
        const map = transcripts.get(agentKey) ?? new Map();
        for (const [k, turns] of Object.entries(stored)) {
          // A turn still "working" at load was interrupted by a reload.
          const loaded = (Array.isArray(turns) ? turns : []).map(t =>
            t && typeof t === "object" ? { ...t, outcome: t.outcome === "working" ? "cancelled" : t.outcome } : t);
          const live = map.get(k) ?? [];
          map.set(k, [...loaded.filter(s => !live.some(c => c.at === s.at)), ...live]);
        }
        transcripts.set(agentKey, map);
      }
    } catch { if (!transcripts.has(agentKey)) transcripts.set(agentKey, new Map()); }
    emit();
  }
  const STORE_LIMIT = 512 * 1024;
  function saveTranscripts(agentKey) {
    const map = transcripts.get(agentKey);
    if (!map) return;
    const out = {};
    let budget = STORE_LIMIT;
    // Newest conversations and turns keep the budget; an oversized turn loses
    // its oldest items before the whole transcript is dropped.
    for (const [k, turns] of [...map.entries()].reverse()) {
      const kept = [];
      for (const turn of [...turns].reverse()) {
        let json = JSON.stringify(turn);
        while (turn.items.length && json.length > budget) { turn.items.shift(); json = JSON.stringify(turn); }
        if (json.length <= budget) { kept.unshift(turn); budget -= json.length; }
      }
      if (kept.length) out[k] = kept;
    }
    void agents.storage.set(transcriptKey(agentKey), JSON.stringify(out)).catch(() => {});
  }
  // Session usage snapshots the host's Usage feature reads through the type's
  // `usage` hook. Each Buzz turn is one ACP session, so every session record
  // here is one turn: the /session-stats command (instant, no model request)
  // reports each model request the session made, and the prompt result's
  // consolidated usage is the fallback when stats are unavailable.
  const USAGE_LIMIT = 200;
  const USAGE_MAX_AGE = 45 * 24 * 60 * 60 * 1000;
  const usageStore = new Map();
  const usageLoaded = new Set();
  const usageKey = key => `devin.usage.${key}`;
  const num = value => typeof value === "number" && Number.isFinite(value) ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
  async function ensureUsage(agentKey) {
    if (usageLoaded.has(agentKey)) return;
    usageLoaded.add(agentKey);
    try {
      const stored = JSON.parse((await agents.storage.get(usageKey(agentKey))) || "null");
      const rows = Array.isArray(stored?.sessions) ? stored.sessions : [];
      if (!usageStore.has(agentKey))
        usageStore.set(agentKey, new Map(rows.filter(s => s && typeof s.id === "string").map(s => [s.id, s])));
    } catch { if (!usageStore.has(agentKey)) usageStore.set(agentKey, new Map()); }
  }
  function recordUsage(agentKey, session) {
    if (!usageLoaded.has(agentKey)) {
      void ensureUsage(agentKey).then(() => recordUsage(agentKey, session));
      return;
    }
    let map = usageStore.get(agentKey);
    if (!map) usageStore.set(agentKey, map = new Map());
    map.set(session.id, session);
    const cutoff = Date.now() - USAGE_MAX_AGE;
    while (map.size > USAGE_LIMIT) {
      let oldest;
      for (const s of map.values()) if (!oldest || s.lastAt < oldest.lastAt) oldest = s;
      map.delete(oldest.id);
    }
    for (const s of map.values()) if (s.lastAt < cutoff) map.delete(s.id);
    void agents.storage.set(usageKey(agentKey), JSON.stringify({ v: 1, sessions: [...map.values()] })).catch(() => {});
  }
  // Same digest the bundled session-usage helper computes, so a read that saw
  // the same usage reports the same revision.
  async function revisionOf(session) {
    const data = new TextEncoder().encode(JSON.stringify(session));
    if (globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", data);
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    }
    let hash = 2166136261;
    for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return `fnv-${hash.toString(16)}`;
  }
  // One UsageObservation per model request /session-stats recorded, else a
  // single observation with the turn's consolidated usage. Devin's
  // inputTokens includes cached reads, so the consolidated input subtracts
  // them; stats already report the uncached input. Cost varies by model
  // (swe-2 is plan-included, Claude-via-Devin bills), so each request keeps
  // its own model label plus any ACU/credit amounts the stats report.
  function usageObservations(turn, model, stats, consolidated, contextUse) {
    const observations = [];
    if (Array.isArray(stats?.requests)) {
      for (const req of stats.requests) {
        if (!req || typeof req !== "object") continue;
        const dims = Array.isArray(req.responseDimensions) ? req.responseDimensions : [];
        const dim = uid => dims.find(d => d?.uid === uid)?.kind?.value;
        const metric = uid => num(dim(uid));
        const at = Date.parse(String(req.createdAt ?? ""));
        const tokens = {};
        const input = metric("input_tokens"), output = metric("output_tokens"),
          cacheRead = metric("cached_input_tokens") ?? metric("cache_read_input_tokens"),
          cacheWrite = metric("cache_write_input_tokens") ?? metric("cached_write_input_tokens");
        if (input !== undefined) tokens.input = input;
        if (output !== undefined) tokens.output = output;
        if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
        if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
        const requestModel = typeof dim("model") === "string" && dim("model") ? dim("model") : undefined;
        const usd = num(req.tokenCostUsd);
        const acu = num(req.acuCost) ?? num(req.acu_cost) ?? num(req.acuAmount) ?? num(req.acu_amount);
        const credit = num(req.creditCost) ?? num(req.credit_cost);
        observations.push({
          ...(typeof req.requestId === "string" && req.requestId ? { requestId: req.requestId } : {}),
          at: Number.isFinite(at) ? at : turn.end ?? Date.now(),
          model: requestModel || model || "devin",
          tokens,
          ...(usd ? { cost: { usd, source: "devin" } } : {}),
          ...(acu ? { acu } : {}),
          ...(credit ? { credit } : {}),
        });
      }
    }
    if (observations.length) return { observations, gaps: [] };
    const source = consolidated ?? (contextUse?.input !== undefined ? {
      inputTokens: contextUse.input, outputTokens: contextUse.output,
      cachedReadTokens: contextUse.cacheRead, cachedWriteTokens: contextUse.cacheWrite } : undefined);
    if (!source) return { observations, gaps: ["Devin reported no usage for this turn"] };
    const input = num(source.inputTokens), output = num(source.outputTokens),
      cacheRead = num(source.cachedReadTokens), cacheWrite = num(source.cachedWriteTokens);
    const tokens = {};
    if (input !== undefined && cacheRead !== undefined) tokens.input = Math.max(0, input - cacheRead);
    else if (input !== undefined) tokens.input = input;
    if (output !== undefined) tokens.output = output;
    if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
    if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
    const acu = num(consolidated?.acuAmount) ?? num(consolidated?.acuCost) ?? contextUse?.acu;
    observations.push({ at: turn.end ?? Date.now(), model: model || "devin", tokens,
      ...(acu ? { acu } : {}) });
    return { observations, gaps: ["Usage summed for the turn; per-request stats unavailable"] };
  }
  const clip = (text, limit = TEXT_LIMIT) => {
    const value = String(text ?? "");
    return value.length > limit ? `${value.slice(0, limit)}\n… [truncado]` : value;
  };
  const pretty = value => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  function beginTurn(agentKey, conversation) {
    void ensureTranscripts(agentKey);
    let map = transcripts.get(agentKey);
    if (!map) transcripts.set(agentKey, map = new Map());
    let turns = map.get(conversation.key);
    if (!turns) map.set(conversation.key, turns = []);
    const turn = { at: Date.now(), outcome: "working", items: [], next: 1, agentKey };
    turns.push(turn);
    while (turns.length > TURN_LIMIT) turns.shift();
    while (map.size > HISTORY_LIMIT) map.delete(map.keys().next().value);
    return turn;
  }
  function push(turn, item) {
    if (turn.items.length >= ITEM_LIMIT) return undefined;
    item.id = turn.next++;
    turn.items.push(item);
    emit();
    return item;
  }
  function captureUpdate(turn, update) {
    if (!turn || !update) return;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = update.content?.type === "text" ? update.content.text : "";
      if (!text) return;
      const t = kind === "agent_message_chunk" ? "message" : "thought";
      const last = turn.items[turn.items.length - 1];
      if (last?.t === t) { last.text = clip(last.text + text); emit(); }
      else push(turn, { t, text: clip(text) });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const call = String(update.toolCallId ?? "");
      if (!call) return;
      let item = turn.items.find(i => i.t === "tool" && i.call === call);
      if (!item) item = push(turn, { t: "tool", call, title: "", status: "in_progress",
        input: "", output: "", diffs: [], paths: [], kids: [] });
      if (!item) return;
      if (typeof update.title === "string" && update.title) item.title = clip(update.title, 400);
      if (typeof update.kind === "string") item.kind = update.kind;
      if (typeof update.status === "string") item.status = update.status;
      if (update.rawInput !== undefined) item.input = clip(pretty(update.rawInput));
      if (Array.isArray(update.locations))
        item.paths = update.locations.map(l => typeof l?.path === "string" ? l.path : "").filter(Boolean).slice(0, 8);
      if (Array.isArray(update.content)) {
        const out = [];
        for (const c of update.content) {
          if (c?.type === "diff") {
            if (item.diffs.length < 16)
              item.diffs.push({ path: String(c.path || ""),
                old: c.oldText == null ? undefined : clip(c.oldText, 6000), new: clip(c.newText ?? "", 6000) });
            continue;
          }
          const ct = c?.content;
          if (ct?.type === "text" && ct.text) out.push(ct.text);
          else if (ct?.resource?.text) out.push(ct.resource.text);
          else if (ct?.uri) out.push(ct.uri);
        }
        if (out.length) item.output = clip(out.join("\n"));
      }
      if (update.rawOutput != null && !item.output) item.output = clip(pretty(update.rawOutput));
      saveTranscripts(turn.agentKey);
      return;
    }
    if (kind === "plan" && Array.isArray(update.entries)) {
      push(turn, { t: "plan", entries: update.entries.slice(0, 32)
        .map(e => ({ content: clip(String(e?.content ?? ""), 300), status: String(e?.status ?? "pending") })) });
      return;
    }
    if (kind === "current_mode_update" && update.currentModeId)
      push(turn, { t: "status", text: `Modo: ${update.currentModeId}` });
  }
  function attachPermission(turn, callId, options, outcome) {
    const item = callId && turn?.items.find(i => i.t === "tool" && i.call === String(callId));
    if (!item) return;
    const all = Array.isArray(options) ? options : [];
    const picked = all.find(o => o?.optionId === outcome?.optionId);
    item.perm = { options: all.map(o => String(o?.title || o?.name || o?.optionId || "")).filter(Boolean).slice(0, 8),
      outcome: picked ? String(picked.title || picked.name || outcome.optionId)
        : outcome?.outcome === "cancelled" ? "Cancelado" : String(outcome?.outcome ?? "Solicitada") };
    saveTranscripts(turn.agentKey);
    emit();
  }
  // A Buzz MCP call while a tool runs is a "call recorded during this script".
  function recordEffect(turn, text, failed) {
    if (!turn || !text) return;
    let target;
    for (let i = turn.items.length - 1; i >= 0 && !target; i--)
      if (turn.items[i].t === "tool" && turn.items[i].status === "in_progress") target = turn.items[i];
    if (!target && turn.items[turn.items.length - 1]?.t === "tool") target = turn.items[turn.items.length - 1];
    if (target) { if (target.kids.length < 50) target.kids.push({ t: "effect", id: `${target.id}-${target.kids.length}`, text: clip(text, 300), failed: !!failed }); }
    else push(turn, { t: "effect", text: clip(text, 300), failed: !!failed });
    saveTranscripts(turn.agentKey);
  }
  // Same tag splitting the host applies to its own transcripts.
  const SECTION_TITLES = { identity: "Identidade", base: "Base", workspace: "Pasta de trabalho",
    "community-repositories": "Pasta de repositórios", "agent-instructions": "Instruções do agente",
    team: "Equipe", "core-memory": "Memória principal", "recent-notes": "Notas recentes",
    context: "Contexto", mention: "Menção", "buzz-event": "Evento Buzz", "buzz-events": "Eventos Buzz",
    "thread-context": "Contexto do tópico", "conversation-context": "Contexto da conversa",
    "turn-context": "Contexto do turno", interest: "Interesse", text: "Texto" };
  function sectionsOf(text) {
    const sections = [], loose = [];
    let open;
    for (const line of String(text ?? "").split("\n")) {
      if (open) {
        if (line === `</${open.tag}>`) { sections.push({ tag: open.tag, body: open.lines.join("\n") }); open = undefined; }
        else open.lines.push(line);
        continue;
      }
      const start = /^<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>$/.exec(line);
      if (start?.[1]) open = { tag: start[1], lines: [] };
      else loose.push(line);
    }
    if (open) loose.push(`<${open.tag}>`, ...open.lines);
    const rest = loose.join("\n").trim();
    if (rest) sections.push({ tag: "text", body: rest });
    return sections.map(s => ({ ...s, body: clip(s.body) }));
  }
  // The user's request line: prefer the wrapped buzz-event record the kit wrote
  // (it carries the author's display name), then the raw mention event.
  function requestFrom(delivery, text) {
    for (const s of sectionsOf(text)) {
      if (s.tag !== "buzz-event" && s.tag !== "buzz-events") continue;
      const match = /^(\{[^\n]*\})\nRequest: ("[^\n]*")$/.exec(s.body.trim());
      if (!match) continue;
      try {
        const event = JSON.parse(match[1]);
        const request = JSON.parse(match[2]);
        if (typeof request === "string")
          return { author: event.display_name || event.username || event.name
            || (event.pubkey ? `…${String(event.pubkey).slice(-6)}` : delivery.agent.name), text: clip(request) };
      } catch { /* fall through to the raw event */ }
    }
    const trigger = delivery.trigger;
    if (trigger?.type === "mention" && typeof trigger.event?.content === "string")
      return { author: `…${String(trigger.event.pubkey ?? "?").slice(-6)}`, text: clip(trigger.event.content) };
    return { author: delivery.agent.name, text: trigger?.type ? `Disparo ${trigger.type}` : "Turno" };
  }
  const ACTIVITY_STATUS = { working: "Trabalhando", done: "Concluído", failed: "Falhou", cancelled: "Interrompido" };
  const SESSION_STATUS = { working: "Working", done: "Done", failed: "Failed", cancelled: "Cancelled" };
  const activityTime = at => new Date(at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  function InlineHead({ id, title }) {
    return h("div", { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": "" },
      h("div", { className: "buzz-content-header-copy" }, h("h3", { id, className: "buzz-content-header-title" }, title)));
  }
  // Transcript subview, mirroring the bundled Codex Activity transcript: turn
  // status + duration, collapsible system prompt, the user's request, then the
  // ordered steps (thoughts, replies, tool calls with Input/Output, plan).
  const fmtClock = at => new Date(at).toLocaleTimeString("pt-BR");
  const fmtDur = (a, b) => {
    const s = Math.max(0, Math.round(((b ?? Date.now()) - a) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const firstLine = text => String(text || "").split("\n").find(l => l.trim()) || "";
  const boxStyle = { minWidth: 0, border: "1px solid var(--border-standard)",
    borderRadius: "var(--radius-control)", overflow: "hidden" };
  const sumStyle = { display: "flex", alignItems: "center", flexWrap: "wrap",
    gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)", cursor: "pointer", minWidth: 0 };
  const bodyStyle = { display: "grid", gap: "var(--space-3)", padding: "var(--space-1) var(--space-3) var(--space-3)", minWidth: 0 };
  const codeStyle = { margin: 0, padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-control)", background: "var(--color-surface-inset)",
    whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "18rem", overflow: "auto" };
  function CodePanel({ title, text }) {
    return h("section", { style: { display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      h("h4", { className: "m-0 text-body-sm text-subtle", style: { margin: 0, fontWeight: 600 } }, title),
      h("pre", { className: "text-mono", style: codeStyle }, text));
  }
  function Sections({ sections }) {
    return h("details", { style: boxStyle },
      h("summary", { className: "text-body-sm", style: sumStyle }, caret(),
        `Prompt do sistema · ${sections.length} ${sections.length === 1 ? "seção" : "seções"}`),
      h("div", { style: bodyStyle }, sections.map((s, i) =>
        h("section", { key: i, style: { display: "grid", gap: "var(--space-1)", minWidth: 0 } },
          h("h4", { className: "m-0 text-body-sm text-subtle", style: { margin: 0, fontWeight: 600 } },
            SECTION_TITLES[s.tag] ?? s.tag),
          h("pre", { className: "text-mono", style: codeStyle }, s.body)))));
  }
  function Disclosure({ item, iconName, label, preview, metadata, children }) {
    const failed = item.status === "failed";
    return h("details", { style: boxStyle, "data-status": item.status || "" },
      h("summary", { className: `text-body-sm${failed ? " text-danger" : ""}`, style: sumStyle },
        iconName ? icon(iconName) : null,
        failed && h("span", { className: "text-danger" }, "Falhou"),
        h("span", { style: { fontWeight: 600 } }, label),
        preview && h("span", { className: "text-subtle", style: { overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 8rem", minWidth: 0 } }, preview),
        metadata),
      h("div", { style: bodyStyle }, children));
  }
  function Diff({ diff }) {
    const before = diff.old === undefined ? [] : diff.old.replace(/\n$/, "").split("\n");
    const after = diff.new.replace(/\n$/, "").split("\n");
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head
        && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    return h("figure", { style: { margin: 0, display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      h("figcaption", { className: "text-body-sm text-subtle" },
        `${diff.old === undefined ? "Novo arquivo" : "Alterado"} ${diff.path}`),
      h("pre", { className: "text-mono", style: codeStyle }, [
        ...before.slice(head, before.length - tail).map((t, i) =>
          h("span", { key: `-${i}`, className: "text-danger" }, `- ${t}\n`)),
        ...after.slice(head, after.length - tail).map((t, i) =>
          h("span", { key: `+${i}`, className: "text-success" }, `+ ${t}\n`))]));
  }
  function ToolEntry({ item, agent }) {
    const failedKids = item.kids.filter(k => k.failed).length;
    const detail = item.paths[0] || (item.title && !item.title.includes("\n") ? item.title : "");
    return h(Disclosure, { item, iconName: KIND_ICON[item.kind] || "wrench",
      label: KIND_ACTION[item.kind] || "Chamar",
      preview: detail,
      metadata: h(R.Fragment, null,
        failedKids > 0 && h("span", { className: "text-danger" },
          `· ${failedKids} chamada${failedKids === 1 ? "" : "s"} falhou`),
        item.perm && h("span", { className: "text-subtle",
          title: `Opções: ${item.perm.options.join(", ")}`,
          style: { display: "inline-flex", alignItems: "center", gap: "var(--space-1)" } },
          icon("shield", 13), item.perm.outcome)) },
      item.title?.includes("\n") && h("pre", { className: "text-mono", style: codeStyle }, item.title),
      item.input && h(CodePanel, { title: "Entrada", text: item.input }),
      item.diffs.map((d, i) => h(Diff, { key: i, diff: d })),
      item.output && h(CodePanel, { title: "Saída", text: item.output }),
      item.kids.length ? h("div", { style: { display: "grid", gap: "var(--space-2)" } },
        h("p", { className: "m-0 text-body-sm text-subtle", style: { margin: 0 } },
          "Chamadas registradas durante este script"),
        item.kids.map(k => h(Entry, { key: k.id, item: k, agent }))) : null);
  }
  function Entry({ item, agent }) {
    if (item.t === "effect")
      return h("div", { style: { display: "flex", alignItems: "baseline", gap: "var(--space-2)", minWidth: 0 } },
        icon(item.failed ? "x" : "check", 13),
        h("span", { className: `text-body-sm${item.failed ? " text-danger" : ""}` }, item.text));
    if (item.t === "status")
      return h("p", { className: "m-0 text-body-sm text-subtle", style: { margin: 0 } }, item.text);
    if (item.t === "thought")
      return h(Disclosure, { item, iconName: "bulb",
        label: firstLine(item.text).replace(/^#{1,6}\s+|^\*\*|\*\*$/g, "") || "Pensando" },
        h("pre", { className: "text-body-sm", style: { ...codeStyle, background: "none", padding: 0 } }, item.text));
    if (item.t === "message")
      return h(Disclosure, { item, iconName: "chat", label: agent.name, preview: firstLine(item.text) },
        h("pre", { className: "text-body-sm", style: { ...codeStyle, background: "none", padding: 0 } }, item.text));
    if (item.t === "plan")
      return h(Disclosure, { item, iconName: "list", label: "Plano",
        preview: `${item.entries.length} passos` },
        h("ul", { "aria-label": "Plano", style: { margin: 0, paddingLeft: "var(--space-5)", display: "grid", gap: "var(--space-1)" } },
          item.entries.map((e, i) => h("li", { key: i, className: "text-body-sm" },
            `${e.status === "completed" ? "☑" : "☐"} ${e.content}`))));
    if (item.t === "tool") return h(ToolEntry, { item, agent });
    return null;
  }
  const STATUS_COLOR = { done: "var(--text-color-success)", failed: "var(--text-color-danger)",
    working: "var(--text-color-accent)", cancelled: "var(--text-color-subtle)" };
  function TurnView({ turn, agent, divider }) {
    const color = STATUS_COLOR[turn.outcome] ?? "var(--text-color-subtle)";
    return h(R.Fragment, null,
      divider && h("div", { role: "separator", style: { display: "flex", alignItems: "center", gap: "var(--space-2)" } },
        h("span", { className: "text-label-sm text-subtle" }, "Nova sessão"),
        h("span", { "aria-hidden": "true", style: { flex: 1, borderTop: "1px solid var(--border-standard)" } })),
      h("article", { style: { display: "grid", gap: "var(--space-3)", minWidth: 0 } },
        h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)" } },
          h("span", { "aria-hidden": "true", style: { width: "var(--space-2)", height: "var(--space-2)",
            borderRadius: "var(--radius-capsule)", background: color, flexShrink: 0 } }),
          h("span", { className: "text-label-sm", style: { color, fontWeight: 600 } },
            ACTIVITY_STATUS[turn.outcome] ?? turn.outcome),
          h("span", { className: "text-body-sm text-subtle" },
            [fmtDur(turn.at, turn.end), turn.end && fmtClock(turn.end)].filter(Boolean).join(" · "))),
        turn.sections?.length ? h(Sections, { sections: turn.sections }) : null,
        turn.request && h("p", { className: "m-0 text-body-sm", style: { margin: 0 } },
          h("strong", null, turn.request.author), ` ${turn.request.text}`),
        turn.items.map(item => h(Entry, { key: item.id, item, agent })),
        turn.outcome === "working" && h("p", { className: "m-0 text-body-sm text-subtle", style: { margin: 0 } }, "Trabalhando…")));
  }
  function TranscriptView({ agent, row, onBack, openThread }) {
    const [, bump] = R.useState(0);
    const turns = transcriptTurns(agent.key, row.key).slice().reverse();
    return h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, gap: "var(--space-4)" } },
      h("div", { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": "" },
        h("button", { type: "button", className: "buzz-button", "data-variant": "ghost", "data-size": "sm",
          "aria-label": "Voltar para a lista de conversas", onClick: onBack,
          style: { display: "inline-flex", alignItems: "center", paddingInline: "var(--space-2)" } }, icon("back")),
        h("div", { className: "buzz-content-header-copy" },
          h("h3", { className: "buzz-content-header-title" }, "Transcript"),
          row.where && h("p", { className: "buzz-content-header-subtitle" }, row.where)),
        h("div", { className: "buzz-content-header-actions" },
          h("button", { type: "button", className: "buzz-button", "data-variant": "ghost", "data-size": "sm",
            "aria-label": "Atualizar transcript", onClick: () => bump(n => n + 1),
            style: { display: "inline-flex", alignItems: "center", paddingInline: "var(--space-2)" } }, icon("refresh")))),
      openThread && h("button", { type: "button", className: "buzz-button", "data-variant": "subtle",
        "data-size": "sm", style: { alignSelf: "flex-start" }, onClick: openThread },
        row.root ? `Thread ${row.root.slice(0, 8)}` : "Abrir conversa"),
      turns.length
        ? turns.map((turn, index) => h(TurnView, { key: String(turn.at), turn, agent, divider: index > 0 }))
        : h("p", { className: "m-0 text-body-sm text-subtle", style: { margin: 0 } },
          "Nenhum turno gravado nesta conversa ainda. O transcript aparece quando o Devin executa uma sessão aqui."));
  }
  function Activity({ agent, conversation, initialTranscript, openConversation }) {
    const [, redraw] = R.useState(0);
    const asked = R.useRef(0);
    const headId = R.useId();
    const hereKey = conversation ? (conversation.rootId ? `${conversation.channelId}/${conversation.rootId}` : conversation.channelId) : "";
    const [open, setOpen] = R.useState(() => initialTranscript && hereKey ? hereKey : "");
    R.useEffect(() => {
      const fn = () => redraw(n => n + 1);
      listeners.add(fn);
      void ensureHistory(agent.key);
      void ensureTranscripts(agent.key);
      return () => listeners.delete(fn);
    }, [agent.key]);
    R.useEffect(() => {
      if (!initialTranscript || initialTranscript.opening === asked.current) return;
      asked.current = initialTranscript.opening;
      if (hereKey) setOpen(hereKey);
      initialTranscript.done();
    }, [initialTranscript?.opening]);
    const rows = activityRows(agent.key).slice().reverse();
    if (open) {
      const row = rows.find(r => r.key === open)
        ?? { key: open, channel: open.split("/")[0], root: open.split("/")[1] };
      return h(TranscriptView, { agent, row, onBack: () => setOpen(""),
        openThread: openConversation && row.channel
          ? () => openConversation(row.channel, row.root) : undefined });
    }
    const here = conversation ? rows.find(row => row.key === hereKey) : undefined;
    const working = Boolean(hereKey && active.has(`${agent.key}/${hereKey}`));
    const recent = rows.filter(row => row.key !== hereKey);
    const nameOf = row => row.where || row.channel.slice(0, 8);
    const rowStyle = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-3)", minWidth: 0 };
    const copyStyle = { flex: "1 1 12rem", minWidth: 0, overflowWrap: "anywhere" };
    const transcriptButton = row =>
      h("button", { type: "button", className: "buzz-button", "data-variant": "subtle", "data-size": "sm",
        "aria-label": `Ver transcript: ${nameOf(row)}`, onClick: () => setOpen(row.key) }, "Ver transcript");
    const entry = (row, first, last) =>
      h("li", { key: row.key, style: { display: "grid", gap: "var(--space-2)", minWidth: 0,
        paddingBlock: first ? 0 : "var(--space-4)", ...(last ? {} : { borderBottom: "1px solid var(--border-standard)" }) } },
        h("div", { style: rowStyle },
          h("div", { style: copyStyle },
            h("span", { className: "text-label-sm", style: { display: "block" } }, nameOf(row)),
            h("p", { className: "m-0 text-body-sm text-subtle", style: { margin: 0 } },
              [row.root ? `Thread ${row.root.slice(0, 8)}` : "Canal", ACTIVITY_STATUS[row.status], row.at ? activityTime(row.at) : ""].filter(Boolean).join(" · "))),
          transcriptButton(row)));
    return h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, gap: "var(--space-6)" } },
      conversation && h("section", { "aria-labelledby": `${headId}-here`, style: { display: "grid", gap: "var(--space-2)", minWidth: 0 } },
        h(InlineHead, { id: `${headId}-here`, title: `Est${conversation.rootId ? "e tópico" : "a conversa"}` }),
        h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "form" },
          h("div", { style: { display: "grid", gap: "var(--space-2)" } },
            h("div", { style: rowStyle },
              here || working ? h("span", { style: copyStyle },
                  h("span", { className: "text-label-sm", style: { display: "block" } }, here ? nameOf(here) : conversation.channelId.slice(0, 8)),
                  h("span", { className: "text-body-sm text-subtle", style: { display: "block" } },
                    [working ? "Trabalhando agora" : ACTIVITY_STATUS[here?.status], here?.at && `Última atividade ${activityTime(here.at)}`].filter(Boolean).join(" · ")))
                : h("span", { style: { display: "grid", gap: "var(--space-1)" } },
                  h("span", { className: "text-label" }, "Nenhuma sessão Devin aqui ainda"),
                  h("span", { className: "text-body-sm text-subtle" }, `Uma começa quando você mencionar o agente ${conversation.rootId ? "neste tópico" : "nesta conversa"}.`)),
              (here || working) && transcriptButton(here ?? { key: hereKey, channel: conversation.channelId,
                root: conversation.rootId }))))),
      h("section", { style: { display: "grid", gap: "var(--space-2)", minWidth: 0 } },
        h(InlineHead, { title: "Conversas recentes" }),
        h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "form" },
          recent.length ? h("ul", { style: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none", minWidth: 0 } },
            recent.map((row, index) => entry(row, index === 0, index === recent.length - 1)))
            : h("p", { className: "m-0 text-body-sm text-subtle", style: { margin: 0 } }, "Nenhuma outra conversa registrada neste app ainda."))));
  }
  function Dashboard() {
    const [, redraw] = R.useState(0);
    const [version, setVersion] = R.useState("");
    R.useEffect(() => { const fn = () => redraw(n => n + 1); listeners.add(fn); return () => listeners.delete(fn); }, []);
    return h("section", { style: { padding: "var(--space-panel-inset)" } },
      h("h1", null, "Devin"),
      h("p", null, "Harness local via ACP. Faça login pelo terminal com devin auth login antes do primeiro uso."),
      h("button", { onClick: async () => {
        try { setVersion(await host.runCommand("version") || "Devin indisponível no PATH do Buzz."); }
        catch { setVersion("Não foi possível consultar o Devin."); }
      } }, "Verificar instalação"), h("p", { role: "status" }, version),
      h("h2", null, "Permissões pendentes"),
      approvals.size ? [...approvals.values()].map(item => h("article", { key: item.id, className: "ui-card", style: { padding: "var(--space-panel-inset)" } },
        h("h3", null, item.agent), h("p", null, item.title),
        h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, item.detail),
        ...item.options.filter(o => ["allow_once", "reject_once"].includes(o.kind)).map(o => h("button", {
          key: o.optionId, onClick: () => item.finish({ outcome: "selected", optionId: o.optionId }),
        }, o.kind === "allow_once" ? "Permitir uma vez" : "Recusar")),
        h("button", { onClick: () => item.finish({ outcome: "cancelled" }) }, "Cancelar")))
        : h("p", null, "Nenhuma permissão pendente."));
  }
  // Account quota the agent CLIs report: Devin's Connect JSON GetUserStatus
  // on the account's api_server_url, and Codex's wham/usage read with the
  // CLI's stored OAuth token. The shell toolbar keeps the latest snapshot of
  // each detected provider; failures degrade to dim rings, and a failed Codex
  // call falls back to the newest local rollout event, which carries the same
  // rate_limits the TUI shows.
  function provider(id, name, mark, primaryLabel, secondaryLabel) {
    return { id, name, mark, primaryLabel, secondaryLabel, present: false,
      state: "idle", at: 0, plan: "", stale: false, primary: undefined,
      primaryReset: 0, secondary: undefined, secondaryReset: 0,
      hideSecondary: false, overageDollars: 0, error: "" };
  }
  const providers = [
    provider("devin", "Devin", devinMark, "Limite diário", "Limite semanal"),
    provider("codex", "Codex", codexMark, "Limite de 5 horas", "Limite semanal")];
  const ghost = provider("ghost", "", devinMark, "Limite diário", "Limite semanal");
  let credential, quotaBusy = false, quotaLast = 0;
  const CREDENTIAL_PATHS = ["~/.local/share/devin/credentials.toml", "~/.devin/credentials.toml"];
  async function readCredential() {
    if (credential !== undefined) return credential;
    for (const path of CREDENTIAL_PATHS) {
      try {
        const text = new TextDecoder().decode(await host.readFile(path));
        const api = /api_server_url\s*=\s*"([^"]+)"/.exec(text)?.[1];
        const token = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(text)?.[1];
        if (api && token) return credential = { api: api.replace(/\/+$/, ""), token };
      } catch { /* next candidate */ }
    }
    return credential = null;
  }
  async function readCodexAuth() {
    try {
      const auth = JSON.parse(new TextDecoder().decode(await host.readFile("~/.codex/auth.json")));
      const access = auth?.tokens?.access_token;
      return typeof access === "string" && access
        ? { access, account: typeof auth?.tokens?.account_id === "string" ? auth.tokens.account_id : "" }
        : null;
    } catch { return null; }
  }
  const titleCase = value => value ? String(value)[0].toUpperCase() + String(value).slice(1) : "";
  const remaining = used => num(used) === undefined ? undefined : Math.max(0, 100 - num(used));
  const windowLabel = seconds => seconds >= 604800 ? "Limite semanal"
    : seconds >= 86400 ? "Limite diário"
    : seconds >= 3600 ? `Limite de ${Math.round(seconds / 3600)} horas`
    : seconds > 0 ? `Limite de ${Math.max(1, Math.round(seconds / 60))} min` : "Limite primário";
  const paint = (p, patch) => Object.assign(p, { state: "", at: Date.now(), error: "" }, patch);
  function fail(p, error) {
    p.state = "error"; p.stale = false; p.primary = p.secondary = undefined;
    p.error = error instanceof Error ? error.message : "falha ao consultar limites";
  }
  function windowPatch(first, second, plan, stale = false) {
    return { stale, plan: titleCase(plan),
      primaryLabel: first.label, primary: first.pct, primaryReset: first.reset,
      secondaryLabel: second?.label ?? "Limite semanal",
      secondary: second?.pct, secondaryReset: second?.reset ?? 0,
      hideSecondary: !second };
  }
  async function fillDevin(p, cred) {
    if (!host.request) throw new Error("este Buzz não oferece host.request");
    const version = "3000.14.30821";
    const response = await host.request({
      url: `${cred.api}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      method: "POST",
      headers: { authorization: `Bearer ${cred.token}`, "content-type": "application/json",
        "connect-protocol-version": "1" },
      body: JSON.stringify({ metadata: { apiKey: cred.token, ideName: "devin", ideVersion: version,
        extensionName: "devin", extensionVersion: version, requestId: Math.floor(Math.random() * 2147483647),
        os: "linux", locale: "en-US", url: "https://devin.ai" } }),
      timeoutMs: 15000,
    });
    const body = JSON.parse(response.body || "null");
    const status = body?.userStatus?.planStatus ?? body?.planStatus,
      plan = body?.planInfo || status?.planInfo || {};
    if (response.status >= 400 || !status) throw new Error(`resposta ${response.status || "vazia"}`);
    paint(p, { stale: false,
      plan: String(plan.planName || ""),
      primary: num(status.dailyQuotaRemainingPercent),
      secondary: num(status.weeklyQuotaRemainingPercent),
      primaryReset: (num(status.dailyQuotaResetAtUnix) ?? 0) * 1000,
      secondaryReset: (num(status.weeklyQuotaResetAtUnix) ?? 0) * 1000,
      overageDollars: (num(status.overageBalanceMicros) ?? 0) / 1e6,
      hideSecondary: Boolean(plan.hideWeeklyQuota) });
  }
  async function codexRollout() {
    if (!host.runCommand) return null;
    const out = await host.runCommand("codex-rollout").catch(() => null);
    const lines = out?.trim().split("\n").filter(Boolean) ?? [];
    const event = lines.slice(1).map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean).pop();
    const limits = event?.payload?.rate_limits;
    if (!limits?.primary) return null;
    const at = Date.parse(event?.timestamp ?? "") || (Number(lines[0]) || 0) * 1000 || Date.now();
    const win = w => w && ({ label: windowLabel((num(w.window_minutes) ?? 0) * 60),
      pct: remaining(w.used_percent), reset: (num(w.resets_at) ?? 0) * 1000 });
    return { ...windowPatch(win(limits.primary), win(limits.secondary), limits.plan_type, true), at };
  }
  async function fillCodex(p, auth) {
    if (!host.request) throw new Error("este Buzz não oferece host.request");
    const response = await host.request({
      url: "https://chatgpt.com/backend-api/wham/usage", method: "GET",
      headers: { authorization: `Bearer ${auth.access}`,
        ...(auth.account ? { "chatgpt-account-id": auth.account } : {}) },
      timeoutMs: 15000 });
    let patch, reason;
    if (response.status === 200) {
      const body = JSON.parse(response.body || "null");
      const limit = body?.rate_limit;
      if (limit?.primary_window) {
        const win = w => w && ({ label: windowLabel(num(w.limit_window_seconds) ?? 0),
          pct: remaining(w.used_percent), reset: (num(w.reset_at) ?? 0) * 1000 });
        patch = windowPatch(win(limit.primary_window), win(limit.secondary_window), body.plan_type);
      } else reason = "resposta sem rate_limit";
    } else reason = response.status === 401 || response.status === 403
      ? "token expirado, rode codex no terminal" : `resposta ${response.status || "vazia"}`;
    if (patch) return paint(p, patch);
    const stale = await codexRollout();
    if (!stale) throw new Error(reason);
    paint(p, { ...stale, error: reason });
  }
  async function refreshQuota(force) {
    if (quotaBusy || disposed || (!force && Date.now() - quotaLast < 60000)) return;
    quotaBusy = true; quotaLast = Date.now();
    try {
      const [cred, auth] = await Promise.all([readCredential(), readCodexAuth()]);
      const jobs = [];
      providers[0].present = Boolean(cred);
      if (cred) jobs.push(fillDevin(providers[0], cred).catch(error => fail(providers[0], error)));
      providers[1].present = Boolean(auth);
      if (auth) jobs.push(fillCodex(providers[1], auth).catch(error => fail(providers[1], error)));
      await Promise.all(jobs);
    } finally { quotaBusy = false; emit(); }
  }
  const RING_C = 2 * Math.PI * 5.5;
  const ringColor = pct => pct === undefined ? "var(--text-subtle)"
    : pct < 15 ? "var(--text-danger)" : pct < 40 ? "var(--text-warning)" : "var(--text-success)";
  function Ring({ pct, label, size = 16 }) {
    const clamped = Math.max(0, Math.min(100, pct ?? 0));
    return h("svg", { width: size, height: size, viewBox: "0 0 16 16", role: "img", "aria-label": label,
        style: { flexShrink: 0 } },
      h("circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "var(--border-standard)", strokeWidth: 2 }),
      pct !== undefined && h("circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: ringColor(pct),
        strokeWidth: 2, strokeLinecap: "round", transform: "rotate(-90 8 8)",
        strokeDasharray: `${(clamped / 100) * RING_C} ${RING_C}` }));
  }
  function devinMark() {
    return h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
        style: { flexShrink: 0 } },
      h("path", { d: "M12 3l7.5 9L12 21 4.5 12z" }), h("path", { d: "M12 8l3.5 4-3.5 4L8.5 12z" }));
  }
  function codexMark() {
    return h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
        style: { flexShrink: 0 } },
      h("path", { d: "M12 3.5v17M4.9 7.75l14.2 8.5M4.9 16.25l14.2-8.5" }));
  }
  const resetText = at => {
    if (!at) return "";
    const ms = at - Date.now();
    const hours = ms <= 0 ? 0 : Math.max(1, Math.round(ms / 36e5));
    const relative = ms < 48 * 36e5
      ? `${hours} hora${hours === 1 ? "" : "s"}` : `${Math.round(ms / 864e5)} dias`;
    return `${relative} (${new Date(at).toLocaleString("pt-BR",
      { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })})`;
  };
  const captionSmall = { fontSize: 11 };
  const captionTiny = { fontSize: 10 };
  function quotaLine(label, pct, reset) {
    return h("div", { style: { display: "flex", alignItems: "center",
        columnGap: "var(--space-2)", minWidth: 0 } },
      h("span", { style: { display: "inline-flex", flexShrink: 0 } },
        h(Ring, { pct, label, size: 13 })),
      h("span", { style: { display: "inline-flex", flexDirection: "column", minWidth: 0 } },
        h("span", { className: "text-caption", style: captionSmall },
          `${label}: ${pct === undefined ? "indisponível" : `${Math.round(pct)}% restante`}`),
        reset ? h("span", { className: "text-caption text-subtle", style: captionSmall },
          `Renova em ${resetText(reset)}`) : null));
  }
  function ProviderDetail({ p, hideStamp }) {
    return h("div", { style: { display: "grid", gap: "var(--space-2)", minWidth: 0 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)" } },
        p.mark(),
        h("span", { className: "text-label", style: { fontWeight: 600 } },
          `${p.name}${p.plan ? ` · ${p.plan}` : ""}`)),
      p.state === "error"
        ? h("p", { className: "m-0 text-caption text-danger", style: { ...captionSmall, margin: 0 } },
          `Não foi possível consultar os limites (${p.error}).`)
        : h(R.Fragment, null,
          h("div", { style: { display: "grid", gap: "var(--space-2)" } },
            quotaLine(p.primaryLabel, p.primary, p.primaryReset),
            !p.hideSecondary && quotaLine(p.secondaryLabel, p.secondary, p.secondaryReset)),
          p.stale ? h("span", { className: "text-caption text-subtle", style: captionSmall },
            `Dados da última sessão local${p.error ? ` · ${p.error}` : ""}`) : null,
          p.overageDollars ? h("span", { className: "text-caption text-subtle", style: captionTiny },
            `Saldo excedente: US$ ${Math.abs(p.overageDollars).toFixed(2)}${p.overageDollars < 0 ? " devido" : ""}`) : null,
          p.at && !hideStamp ? h("span", { className: "text-caption text-subtle", style: captionTiny },
            `Atualizado ${new Date(p.at).toLocaleTimeString("pt-BR")}`) : null));
  }
  function QuotaDetail() {
    const shown = providers.filter(p => p.present);
    if (!shown.length)
      return h("p", { className: "m-0 text-caption text-subtle", style: { ...captionSmall, margin: 0 } },
        "Nenhum provider detectado. Faça login no Devin ou no Codex.");
    const stamps = shown.map(p => p.at).filter(Boolean);
    const shared = stamps.length === shown.length &&
      Math.max(...stamps) - Math.min(...stamps) <= 60e3 ? Math.max(...stamps) : 0;
    return h("div", { style: { display: "grid", gap: "var(--space-4)", minWidth: 0 } },
      shown.map(p => h(ProviderDetail, { key: p.id, p, hideStamp: !!shared })),
      shared ? h("div", { className: "text-caption text-subtle",
          style: { ...captionTiny, textAlign: "center" } },
        `Atualizado ${new Date(shared).toLocaleTimeString("pt-BR")}`) : null);
  }
  function QuotaToolbar() {
    const [, redraw] = R.useState(0);
    const [open, setOpen] = R.useState(false);
    const wrap = R.useRef(null);
    R.useEffect(() => {
      const fn = () => redraw(n => n + 1);
      listeners.add(fn);
      void refreshQuota();
      const timer = setInterval(() => void refreshQuota(), 5 * 60 * 1000);
      return () => { listeners.delete(fn); clearInterval(timer); };
    }, []);
    R.useEffect(() => {
      if (!open) return;
      const away = e => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
      const esc = e => { if (e.key === "Escape") setOpen(false); };
      document.addEventListener("mousedown", away);
      document.addEventListener("keydown", esc);
      return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
    }, [open]);
    const shown = providers.filter(p => p.present);
    return h("div", { ref: wrap, style: { position: "relative", display: "inline-flex" },
        onMouseLeave: e => { if (!wrap.current?.contains(e.relatedTarget)) setOpen(false); } },
      h("button", { type: "button", className: "buzz-button", "data-variant": "ghost", "data-size": "sm",
        "aria-label": "Limites de uso", "aria-haspopup": "dialog", "aria-expanded": open,
        title: "Limites de uso",
        onMouseEnter: () => setOpen(true), onFocus: () => setOpen(true),
        onClick: () => { setOpen(o => !o); void refreshQuota(true); },
        style: { display: "inline-flex", alignItems: "center", gap: "var(--space-2)", paddingInline: "var(--space-2)" } },
        (shown.length ? shown : [ghost]).map((p, index) =>
          h("span", { key: p.id, style: { display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
              ...(index ? { borderInlineStart: "1px solid var(--border-standard)", paddingInlineStart: "var(--space-2)" } : {}) } },
            p.mark(),
            h(Ring, { pct: p.primary, label: p.primaryLabel }),
            !p.hideSecondary && h(Ring, { pct: p.secondary, label: p.secondaryLabel })))),
      open && h("div", { role: "dialog", "aria-label": "Limites de uso", className: "popover-surface",
        style: { position: "absolute", top: "calc(100% + var(--space-1))", insetInlineEnd: 0,
          minWidth: "16rem", padding: "var(--space-3)" } },
        h(QuotaDetail)));
  }
  function QuotaPanel() {
    const [, redraw] = R.useState(0);
    R.useEffect(() => {
      const fn = () => redraw(n => n + 1);
      listeners.add(fn);
      void refreshQuota(true);
      return () => listeners.delete(fn);
    }, []);
    return h("div", { style: { display: "grid", gap: "var(--space-4)", padding: "var(--space-panel-inset)", minWidth: 0 } },
      h(QuotaDetail),
      h("button", { type: "button", className: "buzz-button", "data-variant": "outline", "data-size": "sm",
        style: { justifySelf: "start" }, onClick: () => void refreshQuota(true) }, "Atualizar"));
  }
  ctx.panels.register({ id: "devin-quota", title: "Limites",
    matches: target => target === "devin:quota", toolbar: QuotaToolbar, component: QuotaPanel });
  ctx.pages.register({ id: "main", title: "Devin", primary: true, component: Dashboard });
  ctx.effect(() => () => {
    disposed = true;
    for (const stop of probes) void stop();
    for (const item of [...approvals.values()]) item.finish({ outcome: "cancelled" });
    for (const item of active.values()) void item.stop();
    listeners.clear();
  });

  function permission(params, agent, signal) {
    return new Promise(resolve => {
      const id = ++approvalId;
      let timer, settled = false;
      const abort = () => finish({ outcome: "cancelled" });
      const finish = outcome => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        approvals.delete(id); emit(); resolve({ outcome });
      };
      approvals.set(id, { id, agent: agent.name, title: String(params.toolCall?.title || "Ação solicitada pelo Devin"),
        detail: permissionDetail(params.toolCall),
        options: Array.isArray(params.options) ? params.options : [], finish });
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, 120000);
      emit();
      if (signal.aborted || disposed) abort();
    });
  }

  function permissionDetail(call = {}) {
    const parts = [];
    if (typeof call._meta?.["cognition.ai/editableCommand"] === "string") parts.push(call._meta["cognition.ai/editableCommand"]);
    if (call.rawInput != null && JSON.stringify(call.rawInput) !== "{}") parts.push(JSON.stringify(call.rawInput, null, 2));
    for (const item of call.content || []) {
      const content = item.content;
      if (content?.type === "text" && content.text) parts.push(content.text);
      if (item.type === "diff") parts.push(`Arquivo: ${item.path || ""}\nAntes:\n${item.oldText || ""}\nDepois:\n${item.newText || ""}`);
      if (content?.resource?.text) parts.push(content.resource.text);
    }
    if (call.locations?.length) parts.push(JSON.stringify(call.locations, null, 2));
    return (parts.join("\n\n") || "O Devin não forneceu os argumentos desta ação. Recuse se não puder avaliar o pedido.").slice(0, 16000);
  }

  // A delivery that arrives mid-turn with busyMode "steer" joins the running
  // ACP session instead of spawning: it sends only its own prompt text on the
  // shared sessionId and waits for its request, which Devin resolves together
  // with the owner's. Reply text, stats and usage stay with the owning run;
  // the joined run's transcript mark lands in the owner's turn.
  async function steerTurn(delivery, conversation, handle) {
    const kit = agents.harness;
    const controller = new AbortController();
    const forward = () => controller.abort();
    delivery.signal.addEventListener("abort", forward, { once: true });
    if (delivery.signal.aborted) forward();
    // Stopping a joined delivery only drops its own request; the message is
    // already in the session and the owner's process keeps running.
    const stop = async () => { controller.abort(); };
    delivery.interruptible?.(stop);
    let prompt, received = false;
    try {
      prompt = await kit.turnPrompt(delivery, conversation);
      controller.signal.throwIfAborted();
      if (!delivery.current()) throw new Error("Esta solicitação não está mais ativa.");
      if (!handle.joinable || !handle.steer)
        throw new Error("O Devin já está trabalhando nesta conversa. Aguarde ou use Stop.");
      delivery.acknowledged?.();
      received = true;
      const steering = handle.steer(prompt.text, controller.signal);
      const request = requestFrom(delivery, prompt.text);
      push(handle.turn, { t: "status",
        text: `${request.author} adicionou ao turno em execução: ${clip(request.text, 300)}` });
      saveTranscripts(delivery.agent.key);
      delivery.step?.("Devin", "Mensagem incorporada ao turno em execução");
      await steering;
    } finally {
      if (!received) prompt?.restore();
      delivery.signal.removeEventListener("abort", forward);
      emit();
    }
  }
  async function run(delivery) {
    const kit = agents.harness;
    const conversation = await kit.conversation(delivery, "thread");
    if (!conversation || !delivery.current()) { delivery.ignored?.(); return; }
    if (delivery.agent.protection) throw new Error("Este harness não executa agentes protegidos.");
    const key = `${delivery.agent.key}/${conversation.key}`;
    const cfg = config(delivery.config);
    const existing = active.get(key);
    if (existing) {
      if (cfg.busyMode === "steer" && existing.joinable && existing.steer)
        return steerTurn(delivery, conversation, existing);
      throw new Error("O Devin já está trabalhando nesta conversa. Aguarde ou use Stop.");
    }
    const controller = new AbortController();
    const forward = () => controller.abort();
    delivery.signal.addEventListener("abort", forward, { once: true });
    if (delivery.signal.aborted) forward();
    let process, server, prompt, received = false, replied = false;
    const pending = new Map();
    const toolCalls = new Map();
    let sequence = 0, buffer = "", finalText = "", lastStep = "", outcome, fatal;
    // Usage capture: the session id, its model in use, the latest context
    // window report, and /session-stats data collected after the turn.
    let acpSession, sessionModel = "", contextUse, promptUsage;
    let statsCollecting = false, statsData, statsDone;
    const rejectAll = error => { fatal = error; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
    const stop = async () => {
      controller.abort(); rejectAll(new Error("Turno interrompido."));
      if (process) await process.kill();
    };
    const handle = { stop, joinable: false, steer: undefined, turn: undefined };
    active.set(key, handle);
    delivery.interruptible?.(stop);
    recordActivity(delivery.agent.key, conversation, "working");
    const turn = beginTurn(delivery.agent.key, conversation);
    handle.turn = turn;
    const abort = () => { rejectAll(new Error("Turno interrompido.")); if (process) void process.kill(); };
    controller.signal.addEventListener("abort", abort, { once: true });
    const write = value => process.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
    async function dispatch(message) {
      if (message.method) {
        if (message.method === "session/update") {
          const update = message.params?.update;
          if (!statsCollecting) captureUpdate(turn, update);
          if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate) && update.toolCallId)
            toolCalls.set(update.toolCallId, { ...toolCalls.get(update.toolCallId), ...update });
          if (update?.sessionUpdate === "usage_update") {
            const meta = update._meta || {};
            contextUse = { used: num(update.used), size: num(update.size),
              input: num(meta["cognition.ai/inputTokens"]), output: num(meta["cognition.ai/outputTokens"]),
              cacheRead: num(meta["cognition.ai/cachedReadTokens"]), cacheWrite: num(meta["cognition.ai/cachedWriteTokens"]),
              acu: num(meta["cognition.ai/acuAmount"]) };
          }
          if (update?.sessionUpdate === "config_option_update") {
            const field = (Array.isArray(update.configOptions) ? update.configOptions : [])
              .find(o => o?.category === "model" && o?.type === "select");
            if (typeof field?.currentValue === "string" && field.currentValue) sessionModel = field.currentValue;
          }
          if (statsCollecting && update?.sessionUpdate === "agent_message_chunk") {
            const stats = update._meta?.["cognition.ai/sessionStats"];
            if (stats && typeof stats === "object") statsData = stats;
          }
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && !statsCollecting) {
            finalText += update.content.text;
            if (finalText.length > 2 * 1024 * 1024) throw new Error("Resposta do Devin excedeu o limite do plugin.");
          }
          if (update?.sessionUpdate === "tool_call") {
            lastStep = String(update.title || "Ferramenta");
            delivery.step?.("Devin", lastStep);
            recordActivity(delivery.agent.key, conversation, "working", `Devin: ${lastStep}`);
          }
        } else if (message.id !== undefined) {
          if (message.method === "session/request_permission") {
            delivery.step?.("Permissão pendente", "Abra a página Devin no Buzz");
            const params = message.params || {};
            const result = await permission({ ...params, toolCall: { ...toolCalls.get(params.toolCall?.toolCallId), ...params.toolCall } }, delivery.agent, controller.signal);
            attachPermission(turn, params.toolCall?.toolCallId, params.options, result?.outcome);
            if (!controller.signal.aborted) await write({ id: message.id, result });
          } else await write({ id: message.id, error: { code: -32601, message: "Método do cliente não suportado" } });
        }
      } else if (pending.has(message.id)) {
        const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(new Error(`Devin ACP: ${message.error.message || message.error.code}`));
        else p.resolve(message.result);
      }
    }
    function stdout(chunk) {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { rejectAll(new Error("Mensagem ACP excedeu o limite.")); void stop(); return; }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { void dispatch(JSON.parse(line)).catch(error => { rejectAll(error); void stop(); }); }
        catch { rejectAll(new Error("Saída ACP inválida.")); void stop(); }
      }
    }
    function request(method, params, timeout = 60000) {
      if (fatal) return Promise.reject(fatal);
      controller.signal.throwIfAborted();
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error(`Tempo esgotado: ${method}`)); void stop();
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
      });
    }
    // /session-stats answers instantly, without a model request; its
    // sessionStats _meta lists every model request the session made. Older
    // Devin versions answer "Unknown command" and leave statsData empty.
    async function collectStats() {
      statsCollecting = true;
      try {
        await request("session/prompt", { sessionId: acpSession.sessionId,
          prompt: [{ type: "text", text: "/session-stats" }] }, 10000);
      } catch { /* stats are best-effort */ }
      finally { statsCollecting = false; }
    }
    // A joined run's prompt shares this pending map, so an owner stop or a
    // dispose rejects it the same way; an abort of the joined delivery only
    // removes its own entry and leaves the session (and its message) running.
    handle.steer = (text, signal) => new Promise((resolve, reject) => {
      if (!handle.joinable) { reject(new Error("O Devin já está trabalhando nesta conversa. Aguarde ou use Stop.")); return; }
      if (fatal) { reject(fatal); return; }
      if (signal?.aborted) { reject(new Error("Turno interrompido.")); return; }
      const id = ++sequence;
      const detach = () => signal?.removeEventListener("abort", onAbort);
      const settle = (fn, value) => { if (pending.delete(id)) { clearTimeout(timer); detach(); fn(value); } };
      const onAbort = () => settle(reject, new Error("Turno interrompido."));
      const timer = setTimeout(() => settle(reject, new Error("Tempo esgotado: session/prompt")), 29 * 60 * 1000);
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, { resolve: value => { detach(); resolve(value); },
        reject: error => { detach(); reject(error); }, timer });
      write({ id, method: "session/prompt", params: { sessionId: acpSession.sessionId,
        prompt: [{ type: "text", text }] } })
        .catch(() => settle(reject, new Error("Falha ao enviar a mensagem ao Devin.")));
    });
    try {
      const cwd = await host.resolveDirectory(cfg.cwd);
      controller.signal.throwIfAborted();
      const tools = kit.tools(delivery.agent, conversation, { read: path => host.readFile(path, { cwd }) });
      server = await host.serveMcp(async message => {
        controller.signal.throwIfAborted();
        if (!delivery.current()) throw new Error("Solicitação inativa.");
        const response = await tools(message);
        const raw = String(message?.params?.name || "");
        if (message?.method === "tools/call") {
          const failed = Boolean(response?.result?.isError || response?.error);
          const posted = /(^|__)send$|(^|__)reply_in_subthread$/.test(raw);
          const detail = posted ? `Postou ${String(message.params?.arguments?.text ?? "").slice(0, 80)}`.trimEnd()
            : `Chamou ${raw.replace(/^.*__/, "")}`;
          recordEffect(turn, `${delivery.agent.name} · ${detail}`, failed);
          if (posted && response?.result && !response.result.isError && !response.error) replied = true;
        }
        return response;
      }, { sharedSession: true });
      controller.signal.throwIfAborted();
      process = await host.spawn("devin", {
        cwd, args: (delivery.model || cfg.model) ? ["--model", delivery.model || cfg.model] : [],
        // Preserve existing agents' mode; only the owner's saved setting opts in.
        env: { DEVIN_PERMISSION_MODE: cfg.permissionMode, DEVIN_REFUSAL_FALLBACK: null },
        mcp: { url: server.url, headers: server.headers }, onStdout: stdout,
      });
      process.exited.then(() => rejectAll(new Error("O processo Devin encerrou.")), rejectAll);
      controller.signal.throwIfAborted();
      const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "buzz-devin", version: "0.1.0" } });
      if (init.protocolVersion !== 1 || !init.agentCapabilities?.mcpCapabilities?.http)
        throw new Error("O Devin instalado precisa oferecer ACP v1 e MCP HTTP.");
      acpSession = await request("session/new", { cwd, mcpServers: [{ type: "http", name: "buzz", url: server.url, headers: server.headers }] });
      if (typeof acpSession.sessionId !== "string") throw new Error("Devin não retornou uma sessão ACP.");
      if (!sessionModel) {
        const field = acpSession.configOptions?.find?.(o => o?.category === "model" && o?.type === "select");
        sessionModel = field?.currentValue || acpSession.models?.currentModelId || delivery.model || cfg.model || "";
      }
      if (cfg.permissionMode !== "auto") {
        const modeId = cfg.permissionMode === "dangerous" ? "bypass" : cfg.permissionMode;
        if (!acpSession.modes?.availableModes?.some(mode => mode.id === modeId))
          throw new Error("O Devin instalado não oferece o modo de permissão selecionado.");
        await request("session/set_mode", { sessionId: acpSession.sessionId, modeId });
      }
      const system = await kit.systemPrompt(delivery, { scope: "thread", cwd, instructions: cfg.instructions, tools: true });
      prompt = await kit.turnPrompt(delivery, conversation);
      turn.sections = sectionsOf(system);
      turn.request = requestFrom(delivery, prompt.text);
      controller.signal.throwIfAborted();
      if (!delivery.current()) throw new Error("Esta solicitação não está mais ativa.");
      delivery.acknowledged?.();
      received = true;
      handle.joinable = true;
      let result;
      try {
        result = await request("session/prompt", { sessionId: acpSession.sessionId,
          prompt: [{ type: "text", text: system + "\n\n" + prompt.text }] }, 29 * 60 * 1000);
      } finally { handle.joinable = false; }
      promptUsage = result?.usage && typeof result.usage === "object" ? result.usage : undefined;
      controller.signal.throwIfAborted();
      statsDone = collectStats();
      if (result.stopReason !== "end_turn") throw new Error(`Devin encerrou o turno: ${result.stopReason || "motivo desconhecido"}`);
      // Buzz MCP tools post replies themselves. Text-only output is a fallback.
      if (finalText.trim() && !replied) await kit.reply(delivery.agent, conversation, finalText.trim());
      await statsDone;
      outcome = "done";
    } catch (error) {
      outcome = controller.signal.aborted || delivery.signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      turn.end = Date.now();
      turn.outcome = outcome ?? "failed";
      try { await statsDone; } catch { /* stats are best-effort */ }
      if (acpSession?.sessionId && received) {
        try {
          const { observations, gaps } = usageObservations(turn, sessionModel, statsData, promptUsage, contextUse);
          recordUsage(delivery.agent.key, {
            id: acpSession.sessionId,
            channelId: conversation.channel,
            ...(conversation.root ? { root: conversation.root } : {}),
            ...(turn.request?.text ? { title: String(turn.request.text).split("\n")[0].slice(0, 200) } : {}),
            startedAt: turn.at, lastAt: turn.end, gaps, observations,
          });
        } catch { /* usage recording never fails the turn */ }
        void refreshQuota();
      }
      saveTranscripts(delivery.agent.key);
      emit();
      if (received) recordActivity(delivery.agent.key, conversation, outcome ?? "failed",
        finalText.trim().slice(-800) || (lastStep && `Devin: ${lastStep}`) || undefined);
      if (!received) prompt?.restore();
      controller.abort();
      delivery.signal.removeEventListener("abort", forward);
      controller.signal.removeEventListener("abort", abort);
      rejectAll(new Error("Sessão encerrada."));
      try { if (process) { await process.kill(); await process.exited; } }
      finally { try { await server?.close(); } finally { active.delete(key); } }
    }
  }
  agents.register({
    id: "devin", title: "Devin", description: "Devin local via ACP",
    defaults: () => ({ config: config() }),
    adopt: (carry, current) => config({ ...current, instructions: carry.instructions ?? current.instructions,
      cwd: carry.workspace ?? current.cwd }),
    carry: value => ({ instructions: config(value).instructions, workspace: config(value).cwd }),
    importShared: source => source.runtime === "devin" && !source.provider ? config({ model: source.model }) : undefined,
    exportShared: value => ({ runtime: "devin", model: config(value).model }),
    summary: agent => config(agent.config).model || "Padrão da conta Devin",
    models: async agent => {
      const cfg = config(agent.config);
      const offered = await catalog(cfg.cwd);
      return { current: cfg.model || offered.current, models: cfg.model && !offered.models.some(o => o.id === cfg.model)
        ? [{ id: cfg.model, label: cfg.model, efforts: [] }, ...offered.models] : offered.models };
    },
    describeMigration: saved => {
      const cfg = config(saved);
      return [
        { id: "model", label: "Modelo", isOverride: Boolean(cfg.model.trim()) },
        { id: "permission", label: "Permissão", isOverride: cfg.permissionMode !== "auto" },
        { id: "busy", label: "Mensagem durante turno", isOverride: cfg.busyMode !== "queue" },
        { id: "workspace", label: "Pasta de trabalho", isOverride: cfg.cwd !== "~/.buzz", unchangedKey: cfg.cwd },
      ];
    },
    usage: async (agent, { since, signal } = {}) => {
      if (signal?.aborted) throw new Error("Leitura de uso interrompida.");
      await ensureUsage(agent.key);
      if (signal?.aborted) throw new Error("Leitura de uso interrompida.");
      const sessions = [];
      for (const s of usageStore.get(agent.key)?.values() ?? []) {
        if (!(s.lastAt >= (since ?? 0))) continue;
        sessions.push({ ...s, revision: await revisionOf(s) });
      }
      return sessions.sort((a, b) => b.lastAt - a.lastAt);
    },
    sessions: {
      list: agentKey => {
        void ensureHistory(agentKey);
        return activityRows(agentKey).map(row => ({
          channelId: row.channel, ...(row.root ? { root: row.root } : {}), at: row.at,
          status: SESSION_STATUS[row.status] ?? row.status }));
      },
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    CreateModel,
    Create, tabs: [
      { id: "settings", title: "Settings", role: "settings", splitSettings: true, component: Settings },
      { id: "activity", title: "Activity", role: "activity", component: Activity },
    ],
    protectionUnavailable: "O harness Devin não implementa a proteção nativa do Buzz.",
    timeoutMs: 30 * 60 * 1000, run,
  });
}
