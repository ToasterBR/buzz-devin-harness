import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './plugin.js';

function setup(options = {}) {
  let type, page, panel, receive, process;
  let resolveExit;
  let toolsHandler;
  const replies = [], requests = [], effects = [], readPaths = [], hostRequests = [];
  let killed = 0, closed = 0, restored = 0;
  const jsx = (tag, props, ...children) => ({ tag, props, children });
  const storeData = new Map();
  let idCounter = 0;
  const ctx = {
    react: { createElement: jsx, Fragment: 'fragment',
      useState: v => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {},
      useId: () => `t${++idCounter}`, useRef: v => ({ current: v }) },
    effect: fn => effects.push(fn()),
    pages: { register: p => { page = p; } },
    panels: { register: p => { panel = p; } },
    agents: {
      register: t => { type = t; },
      storage: {
        get: async k => storeData.get(k) ?? null,
        set: async (k, v) => { v === null ? storeData.delete(k) : storeData.set(k, v); },
      },
      harness: {
        conversation: async d => d.noConversation ? undefined : { key: d.conv || 'room/thread', channel: 'room' },
        systemPrompt: async () => 'SYSTEM',
        turnPrompt: async () => ({ text: options.promptText ?? 'TURN', restore: () => restored++ }),
        tools: () => async m => {
          if (options.toolError) return { id: m.id, result: { isError: true } };
          return { id: m.id, result: { content: [{ type: 'text', text: 'sent' }] } };
        },
        reply: async (a, c, text) => replies.push({ agent: a.name, text }),
      },
    },
    host: {
      resolveDirectory: async () => '/workspace',
      readFile: async p => { readPaths.push(p);
        return new TextEncoder().encode(p.includes('.codex/auth.json')
          ? (options.codexAuth ?? '') : (options.credentials ?? '')); },
      request: async input => { hostRequests.push(input);
        return (input.url.includes('chatgpt.com') ? options.codexQuota : options.quota)
          ?? { status: 404, headers: {}, body: '{}' }; },
      runCommand: async id => options.commands && id in options.commands
        ? options.commands[id] : 'Devin version',
      serveMcp: async handler => { toolsHandler = handler; return { url: 'http://127.0.0.1:1234/mcp', headers: [], closed: new Promise(() => {}), close: async () => closed++ }; },
      spawn: async (id, opts) => {
        // Native spawn rejects extra fields, including the server lifecycle promise.
        if (opts.mcp) assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(opts.mcp))).sort(), ['headers', 'url']);
        receive = value => opts.onStdout(JSON.stringify(value) + '\n');
        let promptSeen = 0;
        process = {
          exited: new Promise(r => { resolveExit = r; }),
          kill: async () => { killed++; resolveExit(0); },
          write: async line => {
            const msg = JSON.parse(line); requests.push(msg);
            if (!msg.method) return;
            const answer = result => receive({ jsonrpc: '2.0', id: msg.id, result });
            if (msg.method === 'initialize') answer({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } });
            if (msg.method === 'session/new') {
              if (options.newError) receive({ id: msg.id, error: { message: 'login required' } });
              else if (options.holdNew) { options.started?.(); return; }
              else answer({ sessionId: 'session',
                modes: { availableModes: ['smart', 'accept-edits', 'bypass'].map(id => ({ id })) },
                configOptions: [{ category: 'model', type: 'select', currentValue: 'test-model',
                  options: [{ value: 'test-model', name: 'Test Model' }, { value: 'other', name: 'Other Model' }] }] });
            }
            if (msg.method === 'session/set_mode') answer({});
            if (msg.method === 'session/prompt') {
              if (msg.params?.prompt?.[0]?.text === '/session-stats') {
                if (options.statsMeta) receive({ method: 'session/update', params: { update: {
                  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stats' },
                  _meta: { 'cognition.ai/sessionStats': options.statsMeta } } } });
                answer({ stopReason: 'end_turn' });
                return;
              }
              promptSeen++;
              if (options.wait && promptSeen === 1) { options.started?.(); return; }
              if (options.holdSteer && promptSeen > 1) { options.steered?.(msg); return; }
              for (const u of options.updates ?? [])
                receive({ method: 'session/update', params: { update: u } });
              if (options.post) await toolsHandler({ id: 1, method: 'tools/call',
                params: { name: 'send', arguments: { text: options.postText } } });
              if (options.permission) {
                if (options.toolUpdate) receive({ method: 'session/update', params: { update: options.toolUpdate } });
                receive({ id: 900, method: 'session/request_permission', params: {
                  toolCall: options.permissionCall || { title: 'Write file', rawInput: { path: '/tmp/file' } },
                  options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }],
                } });
                options.started?.(); return;
              }
              opts.onStdout('{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"O');
              opts.onStdout('K"}}}}\n');
              answer({ stopReason: options.reason || 'end_turn',
                ...(options.promptUsage ? { usage: options.promptUsage } : {}) });
            }
          },
        };
        options.spawned?.(opts);
        return process;
      },
    },
  };
  apply(ctx);
  function delivery(name = 'Agent') {
    const controller = new AbortController();
    return { agent: { key: name, name }, config: { cwd: '/workspace', model: 'test-model' },
      signal: controller.signal, current: () => true,
      interruptible: stop => { controller.stop = stop; }, controller };
  }
  return { ctx, get type() { return type; }, get page() { return page; }, get panel() { return panel; },
    delivery, replies, requests, hostRequests,
    storeData,
    cleanup: async () => { for (const fn of effects) await fn?.(); },
    stats: () => ({ killed, closed, restored }), receive: value => receive(value),
  };
}

test('registers Devin and preserves imported model and instructions', () => {
  const s = setup();
  assert.equal(s.type.id, 'devin');
  assert.ok(s.type.timeoutMs <= 30 * 60 * 1000);
  assert.equal(s.type.adopt({ workspace: '/old' }, s.type.defaults().config).cwd, '/old');
  assert.equal(s.type.importShared({ runtime: 'other', model: 'x' }), undefined);
  assert.equal(s.type.importShared({ runtime: 'devin', model: 'swe-2-high' }).model, 'swe-2-high');
  assert.equal(s.type.adopt({ instructions: 'custom' }, s.type.defaults().config).instructions, 'custom');
});
test('handles fragmented ACP, passes MCP, posts final text and closes resources', async () => {
  let spawned;
  const s = setup({ spawned: opts => spawned = opts });
  await s.type.run(s.delivery());
  assert.deepEqual(s.replies, [{ agent: 'Agent', text: 'OK' }]);
  assert.equal(spawned.env.DEVIN_PERMISSION_MODE, 'auto');
  assert.deepEqual(spawned.args, ['--model', 'test-model']);
  assert.equal(s.requests.find(m => m.method === 'session/new').params.mcpServers[0].type, 'http');
  assert.equal(s.requests.find(m => m.method === 'session/prompt').params.prompt[0].text, 'SYSTEM\n\nTURN');
  assert.equal(s.stats().closed, 1);
  assert.ok(s.stats().killed >= 1);
});
test('successful Buzz send suppresses duplicate fallback; failed send does not', async () => {
  const s = setup({ post: true }); await s.type.run(s.delivery()); assert.equal(s.replies.length, 0);
  const f = setup({ post: true, toolError: true }); await f.type.run(f.delivery()); assert.equal(f.replies.length, 1);
});
test('unadmitted and protected deliveries never start a process', async () => {
  const s = setup(); const d = s.delivery(); d.noConversation = true; await s.type.run(d);
  assert.equal(s.requests.length, 0);
  const p = s.delivery(); p.agent.protection = {}; await assert.rejects(s.type.run(p), /protegidos/);
});
test('ACP failure reaches host and releases resources', async () => {
  const s = setup({ newError: true }); await assert.rejects(s.type.run(s.delivery()), /login required/);
  assert.equal(s.stats().closed, 1); assert.equal(s.replies.length, 0);
});
test('Stop interrupts a pending prompt and permits a later turn', async () => {
  let started; const ready = new Promise(r => started = r);
  const options = { wait: true, started }; const s = setup(options); const d = s.delivery();
  const running = s.type.run(d); const rejected = assert.rejects(running, /interrompido/);
  await ready; await d.controller.stop(); await rejected;
  assert.equal(s.stats().closed, 1);
  options.wait = false; await s.type.run(s.delivery()); assert.equal(s.replies.length, 1);
});
test('reply tracking resets between turns of the same harness', async () => {
  const options = { post: true }; const s = setup(options);
  await s.type.run(s.delivery('one')); options.post = false;
  await s.type.run(s.delivery('two'));
  assert.deepEqual(s.replies, [{ agent: 'two', text: 'OK' }]);
});
test('permission is only granted by explicit UI action; unload cancels pending work', async () => {
  let started; const ready = new Promise(r => started = r);
  const s = setup({ permission: true, started }); const d = s.delivery();
  const running = s.type.run(d); const rejected = assert.rejects(running, /interrompido/);
  await ready;
  assert.equal(s.requests.some(m => m.id === 900), false);
  const tree = s.page.component();
  assert.ok(JSON.stringify(tree, (k,v) => typeof v === 'function' ? undefined : v).includes('Write file'));
  await s.cleanup(); await rejected;
  assert.equal(s.stats().closed, 1);
});
test('aborted turn and non-end stop reasons never publish fallback', async () => {
  const s = setup({ reason: 'max_tokens' }); await assert.rejects(s.type.run(s.delivery()), /max_tokens/);
  assert.equal(s.replies.length, 0);
  const b = setup(); const d = b.delivery(); d.controller.abort();
  await assert.rejects(b.type.run(d)); assert.equal(b.requests.length, 0);
});

test('discovers account models without prompting, caches and preserves an imported model', async () => {
  const s = setup();
  const offered = await s.type.models({ config: { cwd: '/workspace', model: 'legacy-model' } });
  assert.equal(offered.current, 'legacy-model');
  assert.deepEqual(offered.models.map(m => m.id), ['legacy-model', 'test-model', 'other']);
  assert.equal(s.requests.some(m => m.method === 'session/prompt'), false);
  await s.type.models({ config: { cwd: '/workspace' } });
  assert.equal(s.requests.filter(m => m.method === 'session/new').length, 1);
  assert.equal(s.stats().killed, 1);
  await s.cleanup();
});
test('catalog failure releases process and can retry', async () => {
  const options = { newError: true }; const s = setup(options);
  await assert.rejects(s.type.models({ config: {} }), /login required/);
  assert.equal(s.stats().killed, 1);
  options.newError = false;
  assert.equal((await s.type.models({ config: {} })).models.length, 2);
});
test('owner permission setting selects ACP mode and per-turn model takes precedence', async () => {
  for (const [permissionMode, modeId] of [['smart', 'smart'], ['accept-edits', 'accept-edits'], ['dangerous', 'bypass']]) {
    let spawned; const s = setup({ spawned: opts => spawned = opts }); const d = s.delivery();
    d.config.permissionMode = permissionMode; d.model = 'other';
    await s.type.run(d);
    assert.equal(spawned.env.DEVIN_PERMISSION_MODE, permissionMode);
    assert.deepEqual(spawned.args, ['--model', 'other']);
    assert.equal(s.requests.find(m => m.method === 'session/set_mode').params.modeId, modeId);
  }
  assert.equal(setup().type.adopt({}, { permissionMode: 'invalid' }).permissionMode, 'auto');
});
test('permission shows ACP text content even when rawInput is empty', async () => {
  let started; const ready = new Promise(r => started = r);
  const s = setup({ permission: true, started, permissionCall: { title: 'Execute', rawInput: {},
    content: [{ type: 'content', content: { type: 'text', text: 'printf hello' } }] } });
  const d = s.delivery(); const running = s.type.run(d); const rejected = assert.rejects(running, /interrompido/);
  await ready;
  const tree = JSON.stringify(s.page.component(), (k, v) => typeof v === 'function' ? undefined : v);
  assert.ok(tree.includes('printf hello'));
  assert.equal(s.requests.some(m => m.id === 900), false);
  await d.controller.stop(); await rejected;
});
test('missing permission details explain the absence instead of displaying empty JSON', async () => {
  let started; const ready = new Promise(r => started = r);
  const s = setup({ permission: true, started, permissionCall: { title: 'Execute', rawInput: {} } });
  const d = s.delivery(); const running = s.type.run(d); const rejected = assert.rejects(running, /interrompido/);
  await ready;
  assert.ok(JSON.stringify(s.page.component()).includes('não forneceu os argumentos'));
  await d.controller.stop(); await rejected;
});
test('queue mode refuses a second concurrent delivery on the same conversation', async () => {
  let started; const ready = new Promise(r => started = r);
  let spawns = 0;
  const options = { wait: true, started, spawned: () => spawns++ };
  const s = setup(options); const d = s.delivery();
  const running = s.type.run(d); const rejected = assert.rejects(running, /interrompido/);
  await ready;
  await assert.rejects(s.type.run(s.delivery()), /trabalhando nesta conversa/);
  await d.controller.stop(); await rejected;
  assert.equal(spawns, 1);
  assert.equal(s.requests.filter(m => m.method === 'session/prompt').length, 1);
});

test('steer mode injects the delivery into the running session without a new process', async () => {
  let started; const ready = new Promise(r => started = r);
  let spawns = 0;
  const options = { wait: true, started, spawned: () => spawns++ };
  const s = setup(options); const d = s.delivery();
  const running = s.type.run(d);
  await ready;
  const joined = s.delivery(); joined.config.busyMode = 'steer';
  await s.type.run(joined);
  const prompts = s.requests.filter(m => m.method === 'session/prompt'
    && m.params.prompt[0].text !== '/session-stats');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].params.sessionId, prompts[0].params.sessionId);
  assert.equal(prompts[1].params.prompt[0].text, 'TURN');
  assert.equal(spawns, 1);
  assert.equal(s.requests.filter(m => m.method === 'session/new').length, 1);
  s.receive({ jsonrpc: '2.0', id: prompts[0].id, result: { stopReason: 'end_turn' } });
  await running;
  assert.deepEqual(s.replies, [{ agent: 'Agent', text: 'OK' }]);
  const turns = JSON.parse(s.storeData.get('devin.transcript.Agent'))['room/thread'];
  assert.equal(turns.length, 1);
  assert.ok(turns[0].items.some(i => i.t === 'status' && i.text.includes('adicionou')));
  assert.equal(JSON.parse(s.storeData.get('devin.usage.Agent')).sessions.length, 1);
});

test('steer without a turn in flight spawns and completes normally', async () => {
  const s = setup(); const d = s.delivery(); d.config.busyMode = 'steer';
  await s.type.run(d);
  assert.deepEqual(s.replies, [{ agent: 'Agent', text: 'OK' }]);
});

test('stopping a joined delivery drops only its request and keeps the owner running', async () => {
  let started; const ready = new Promise(r => started = r);
  let steered; const sent = new Promise(r => steered = r);
  const options = { wait: true, started, holdSteer: true, steered: () => steered() };
  const s = setup(options); const d = s.delivery();
  const running = s.type.run(d);
  await ready;
  const joined = s.delivery(); joined.config.busyMode = 'steer';
  const joinedRun = s.type.run(joined);
  const joinedRejected = assert.rejects(joinedRun, /interrompido/);
  await sent;
  const killedBefore = s.stats().killed;
  await joined.controller.stop(); await joinedRejected;
  assert.equal(s.stats().killed, killedBefore);
  const prompts = s.requests.filter(m => m.method === 'session/prompt'
    && m.params.prompt[0].text !== '/session-stats');
  assert.equal(prompts.length, 2);
  s.receive({ jsonrpc: '2.0', id: prompts[0].id, result: { stopReason: 'end_turn' } });
  await running;
});

test('steer during session setup or outside the prompt refuses like queue', async () => {
  let started; const ready = new Promise(r => started = r);
  const options = { holdNew: true, started };
  const s = setup(options); const d = s.delivery();
  const running = s.type.run(d); const rejected = assert.rejects(running, /interrompido/);
  await ready;
  const joined = s.delivery(); joined.config.busyMode = 'steer';
  await assert.rejects(s.type.run(joined), /trabalhando nesta conversa/);
  await d.controller.stop(); await rejected;
});

test('registers split settings and an activity tab like the bundled harnesses', () => {
  const s = setup();
  const tabs = s.type.tabs;
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs.map(t => [t.id, t.role, !!t.splitSettings]),
    [['settings', 'settings', true], ['activity', 'activity', false]]);
  const migration = s.type.describeMigration({ model: 'x', permissionMode: 'smart', cwd: '/w' });
  assert.deepEqual(migration.map(r => r.id), ['model', 'permission', 'busy', 'workspace']);
  assert.equal(migration.find(r => r.id === 'busy').isOverride, false);
  assert.equal(s.type.describeMigration({ busyMode: 'steer' }).find(r => r.id === 'busy').isOverride, true);
});

const expand = node => {
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node?.tag === 'function')
    return expand(node.tag({ ...node.props, children: node.children }));
  if (node && typeof node === 'object' && Array.isArray(node.children))
    return { ...node, children: node.children.map(expand) };
  return node;
};
const findAll = (node, pred, out = []) => {
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, pred, out);
  return out;
};

test('card model field is a compact pill that reports the whole config on change', async () => {
  const s = setup();
  let next;
  const tree = expand(s.type.CreateModel({ config: { cwd: '/w', model: '' }, disabled: false,
    modelAppearance: 'glass-ghost', onChange: c => next = c }));
  const selects = findAll(tree, n => n.tag === 'select');
  assert.equal(selects.length, 1);
  assert.equal(selects[0].props.className, 'buzz-button');
  assert.equal(selects[0].props['data-variant'], 'glass-ghost');
  assert.equal(selects[0].props['data-size'], 'xs');
  selects[0].props.onChange({ target: { value: 'other' } });
  assert.equal(next.model, 'other');
  assert.equal(next.cwd, '/w');
});

test('settings renders the identity box with model and permission rows, runtime with the workspace', async () => {
  const s = setup();
  const agent = { key: 'a', name: 'A', config: { cwd: '/w', model: '', permissionMode: 'smart', instructions: '' } };
  const harnessRow = { tag: 'div', props: { title: 'Harness' }, children: [] };
  const identity = s.type.tabs[0].component({ agent, save: async () => {}, settingsSection: 'identity',
    settingsHost: { typeControl: () => harnessRow } });
  const text = JSON.stringify(identity, (k, v) => typeof v === 'function' ? undefined : v);
  assert.ok(text.includes('Harness') && text.includes('Modelo') && text.includes('Permissão') && text.includes('Instruções'));
  assert.ok(!text.includes('Pasta de trabalho'));
  const runtime = s.type.tabs[0].component({ agent, save: async () => {}, settingsSection: 'runtime',
    settingsContent: { tag: 'div', props: {}, children: ['host-management'] } });
  const runtimeText = JSON.stringify(runtime, (k, v) => typeof v === 'function' ? undefined : v);
  assert.ok(runtimeText.includes('Pasta de trabalho') && runtimeText.includes('host-management'));
  assert.ok(!runtimeText.includes('Permissão'));
});

test('runs record conversation activity for the tab and the sessions contract', async () => {
  const s = setup();
  await s.type.run(s.delivery());
  const rows = s.type.sessions.list('Agent');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channelId, 'room');
  assert.equal(rows[0].status, 'Done');
  assert.ok(s.storeData.get('devin.activity.Agent').includes('done'));
  const tab = s.type.tabs[1].component({ agent: { key: 'Agent', name: 'Agent' }, conversation: { channelId: 'room' } });
  const text = JSON.stringify(tab, (k, v) => typeof v === 'function' ? undefined : v);
  assert.ok(text.includes('Conversas recentes') && text.includes('Esta conversa'));
});

const render = node => JSON.stringify(expand(node), (k, v) => typeof v === 'function' ? undefined : v);

test('activity lists sessions with a Ver transcript entry point', async () => {
  const s = setup();
  await s.type.run(s.delivery());
  const tree = expand(s.type.tabs[1].component({ agent: { key: 'Agent', name: 'Agent' },
    conversation: { channelId: 'room' } }));
  const buttons = findAll(tree, n => n.tag === 'button');
  assert.ok(buttons.some(b => JSON.stringify(b.children).includes('Ver transcript')));
  assert.ok(!JSON.stringify(tree).includes('Abrir conversa'));
});

test('transcript records ACP steps and renders request, thought, tool I/O and plan', async () => {
  const s = setup({ promptText: '<buzz-event>\n{"pubkey":"aa11","display_name":"John"}\nRequest: "verifique os dados"\n</buzz-event>',
    updates: [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Vou inspecionar o arquivo' } },
      { sessionUpdate: 'plan', entries: [{ content: 'Ler dados', status: 'completed' }, { content: 'Responder', status: 'pending' }] },
      { sessionUpdate: 'tool_call', toolCallId: 'exec:0', title: 'ls -la', kind: 'execute',
        status: 'in_progress', rawInput: { command: 'ls -la' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'exec:0', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'total 42' } }] },
    ] });
  const d = s.delivery(); d.conv = 'room';
  await s.type.run(d);
  const text = render(s.type.tabs[1].component({ agent: { key: 'Agent', name: 'Agent' },
    conversation: { channelId: 'room' }, initialTranscript: { opening: 1, done() {} } }));
  assert.ok(text.includes('Transcript') && text.includes('Concluído'));
  assert.ok(text.includes('Prompt do sistema · 1 seção'));
  assert.ok(text.includes('John') && text.includes('verifique os dados'));
  assert.ok(text.includes('Vou inspecionar o arquivo'));
  assert.ok(text.includes('Executar') && text.includes('Entrada') && text.includes('Saída') && text.includes('total 42'));
  assert.ok(text.includes('Plano'));
  const stored = JSON.parse(s.storeData.get('devin.transcript.Agent'));
  assert.equal(stored.room[0].outcome, 'done');
});

test('failed tool calls and Buzz calls recorded during a script show in the transcript', async () => {
  const s = setup({ post: true, postText: 'oi tudo bem', updates: [
    { sessionUpdate: 'tool_call', toolCallId: 'exec:0', title: 'script', kind: 'execute',
      status: 'in_progress', rawInput: { command: './post.sh' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec:0', status: 'failed' },
  ] });
  const d = s.delivery(); d.conv = 'room';
  await s.type.run(d);
  const stored = JSON.parse(s.storeData.get('devin.transcript.Agent')).room[0];
  const tool = stored.items.find(i => i.t === 'tool');
  assert.equal(tool.status, 'failed');
  assert.equal(tool.kids[0].text, 'Agent · Postou oi tudo bem');
  const text = render(s.type.tabs[1].component({ agent: { key: 'Agent', name: 'Agent' },
    conversation: { channelId: 'room' }, initialTranscript: { opening: 1, done() {} } }));
  assert.ok(text.includes('Falhou') && text.includes('Chamadas registradas durante este script'));
  assert.ok(text.includes('Postou oi tudo bem'));
});

test('permission outcome joins the tool call in the transcript', async () => {
  let started; const ready = new Promise(r => started = r);
  const s = setup({ permission: true, started,
    toolUpdate: { sessionUpdate: 'tool_call', toolCallId: 'exec:0', title: 'Editar arquivo', kind: 'edit',
      rawInput: { path: '/tmp/f' } },
    permissionCall: { toolCallId: 'exec:0' } });
  const d = s.delivery(); const running = s.type.run(d);
  await ready;
  const approve = findAll(s.page.component(), n => n.tag === 'button')
    .find(b => JSON.stringify(b.children).includes('Permitir uma vez'));
  approve.props.onClick();
  const promptReq = s.requests.find(m => m.method === 'session/prompt');
  s.receive({ jsonrpc: '2.0', id: promptReq.id, result: { stopReason: 'end_turn' } });
  await running;
  const stored = JSON.parse(s.storeData.get('devin.transcript.Agent'))['room/thread'][0];
  const tool = stored.items.find(i => i.t === 'tool');
  assert.equal(tool.perm.outcome, 'allow');
  assert.deepEqual(tool.perm.options, ['allow', 'deny']);
});

test('permission joins earlier tool update with the sparse real Devin request', async () => {
  let started; const ready = new Promise(r => started = r);
  const s = setup({ permission: true, started,
    toolUpdate: { sessionUpdate: 'tool_call', toolCallId: 'exec:0', title: 'Ran printf', rawInput: { command: 'printf hello' },
      content: [{ type: 'content', content: { type: 'resource', resource: { text: 'printf hello' } } }] },
    permissionCall: { toolCallId: 'exec:0', _meta: { 'cognition.ai/editableCommand': 'printf hello' } } });
  const d = s.delivery(); const running = s.type.run(d); const rejected = assert.rejects(running, /interrompido/);
  await ready;
  const tree = JSON.stringify(s.page.component());
  assert.ok(tree.includes('Ran printf')); assert.ok(tree.includes('printf hello'));
  await d.controller.stop(); await rejected;
});

const usageArgs = (since = 0) => ({ since, signal: new AbortController().signal });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const creds = 'windsurf_api_key = "secret-key"\napi_server_url = "https://server.codeium.com"';
const quotaBody = (plan, wrap = true) => ({ status: 200, headers: {}, body: JSON.stringify({
  ...(wrap ? { userStatus: { planStatus: { dailyQuotaRemainingPercent: 65, weeklyQuotaRemainingPercent: 8,
    dailyQuotaResetAtUnix: 1900000000, weeklyQuotaResetAtUnix: 1901000000,
    overageBalanceMicros: 1500000, planInfo: { planName: plan } } } }
    : { planStatus: { dailyQuotaRemainingPercent: 65, weeklyQuotaRemainingPercent: 8,
      planInfo: { planName: plan } } }),
  planInfo: { planName: plan } }) });
const codexAuthBody = JSON.stringify({ tokens: { access_token: 'codex-token', account_id: 'acct-1' } });
const codexQuotaBody = { status: 200, headers: {}, body: JSON.stringify({
  plan_type: 'plus', rate_limit: { allowed: true,
    primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1900000000 },
    secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1901000000 } } }) };
const rolloutOut = `${1795000000.5}\n${JSON.stringify({ timestamp: '2026-11-19T19:10:06Z', type: 'event_msg',
  payload: { type: 'token_count', rate_limits: { plan_type: 'plus',
    primary: { used_percent: 11, window_minutes: 300, resets_at: 1900000000 },
    secondary: { used_percent: 33, window_minutes: 10080, resets_at: 1901000000 } } } })}`;
const statRequest = (over = {}) => ({ requestId: 'r1', createdAt: '2026-01-02T10:00:00Z',
  responseDimensions: [
    { uid: 'input_tokens', kind: { value: 13290 } },
    { uid: 'output_tokens', kind: { value: 32 } },
    { uid: 'cached_input_tokens', kind: { value: 512 } }], ...over });

test('each /session-stats request becomes an observation and persists with a stable revision', async () => {
  const s = setup({ statsMeta: { requests: [
    { ...statRequest({ responseDimensions: [
        { uid: 'model', kind: { value: 'Claude Sonnet 4.5' } },
        { uid: 'input_tokens', kind: { value: 13290 } },
        { uid: 'output_tokens', kind: { value: 32 } },
        { uid: 'cached_input_tokens', kind: { value: 512 } }] }),
      tokenCostUsd: 0.5, acuCost: 3 },
    statRequest({ requestId: 'r2', createdAt: '2026-01-02T10:00:05Z',
      responseDimensions: [{ uid: 'input_tokens', kind: { value: 100 } },
        { uid: 'output_tokens', kind: { value: 10 } }] }) ] } });
  await s.type.run(s.delivery());
  assert.ok(s.requests.some(m => m.method === 'session/prompt' && m.params.prompt[0].text === '/session-stats'));
  const sessions = await s.type.usage({ key: 'Agent' }, usageArgs());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'session');
  assert.equal(sessions[0].channelId, 'room');
  assert.deepEqual(sessions[0].gaps, []);
  assert.equal(sessions[0].observations.length, 2);
  const [first, second] = sessions[0].observations;
  assert.equal(first.requestId, 'r1');
  assert.equal(first.at, Date.parse('2026-01-02T10:00:00Z'));
  assert.equal(first.model, 'Claude Sonnet 4.5');
  assert.deepEqual(first.tokens, { input: 13290, output: 32, cacheRead: 512 });
  assert.deepEqual(first.cost, { usd: 0.5, source: 'devin' });
  assert.equal(first.acu, 3);
  assert.equal(second.requestId, 'r2');
  assert.equal(second.model, 'test-model');
  assert.deepEqual(second.tokens, { input: 100, output: 10 });
  assert.equal(second.cost, undefined);
  assert.equal(second.acu, undefined);
  assert.equal(typeof sessions[0].revision, 'string');
  assert.ok(sessions[0].revision.length > 8);
  const again = await s.type.usage({ key: 'Agent' }, usageArgs());
  assert.equal(again[0].revision, sessions[0].revision);
  const stored = JSON.parse(s.storeData.get('devin.usage.Agent'));
  assert.equal(stored.sessions[0].id, 'session');
  assert.equal(stored.sessions[0].observations.length, 2);
  assert.equal((await s.type.usage({ key: 'Agent' }, usageArgs(Date.now() + 1e9))).length, 0);
  assert.equal((await s.type.usage({ key: 'Other' }, usageArgs())).length, 0);
});

test('usage falls back to consolidated prompt usage with cached input separated', async () => {
  const s = setup({ promptUsage: { totalTokens: 13834, inputTokens: 13802, outputTokens: 32, cachedReadTokens: 512 } });
  await s.type.run(s.delivery());
  const sessions = await s.type.usage({ key: 'Agent' }, usageArgs());
  assert.equal(sessions[0].observations.length, 1);
  assert.deepEqual(sessions[0].observations[0].tokens, { input: 13290, output: 32, cacheRead: 512 });
  assert.ok(sessions[0].gaps[0].includes('summed'));
});

test('usage falls back to the usage_update counters when nothing else reports', async () => {
  const s = setup({ updates: [
    { sessionUpdate: 'usage_update', used: 13834, size: 262000,
      _meta: { 'cognition.ai/inputTokens': 13802, 'cognition.ai/outputTokens': 32,
        'cognition.ai/cachedReadTokens': 512 } } ] });
  await s.type.run(s.delivery());
  const sessions = await s.type.usage({ key: 'Agent' }, usageArgs());
  assert.deepEqual(sessions[0].observations[0].tokens, { input: 13290, output: 32, cacheRead: 512 });
  assert.ok(sessions[0].gaps[0].includes('summed'));
});

test('a turn without usage still records its session with a gap, never failing the turn', async () => {
  const s = setup();
  await s.type.run(s.delivery());
  const sessions = await s.type.usage({ key: 'Agent' }, usageArgs());
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].observations, []);
  assert.ok(sessions[0].gaps[0].includes('no usage'));
  assert.equal(typeof sessions[0].title, 'string');
});

test('usage reloads stored sessions, prunes the surplus and honors abort', async () => {
  const s = setup();
  const rows = [];
  for (let i = 0; i < 210; i++)
    rows.push({ id: `old${i}`, startedAt: Date.now() - 60000 - i, lastAt: Date.now() - 60000 - i, observations: [] });
  s.storeData.set('devin.usage.Agent', JSON.stringify({ v: 1, sessions: rows }));
  await s.type.run(s.delivery());
  await flush();
  const stored = JSON.parse(s.storeData.get('devin.usage.Agent'));
  assert.equal(stored.sessions.length, 200);
  assert.ok(stored.sessions.some(x => x.id === 'session'));
  const sessions = await s.type.usage({ key: 'Agent' }, usageArgs());
  assert.equal(sessions[0].id, 'session');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(s.type.usage({ key: 'Agent' }, { since: 0, signal: controller.signal }), /interrompida/);
});

test('quota refresh after a turn asks the declared origin and paints the panel detail', async () => {
  const s = setup({ credentials: creds, quota: quotaBody('Pro') });
  await s.type.run(s.delivery());
  await flush(); await flush();
  assert.equal(s.hostRequests.length, 1);
  const call = s.hostRequests[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus');
  assert.equal(call.headers.authorization, 'Bearer secret-key');
  const text = render(s.panel.component());
  assert.ok(text.includes('Devin') && text.includes('Pro'));
  assert.ok(text.includes('Limite diário:') && text.includes('65% restante'));
  assert.ok(text.includes('Limite semanal:') && text.includes('8% restante'));
  assert.ok(/Renova em \d+ dias \(\d{2}\/\d{2}, \d{2}:\d{2}\)/.test(text));
  const toolbar = render(s.panel.toolbar());
  assert.ok(toolbar.includes('Limite diário') && toolbar.includes('Limite semanal'));
});

test('quota renewal shows hours for resets under 48h', async () => {
  const quota = quotaBody('Pro');
  quota.body = JSON.stringify({ userStatus: { planStatus: {
    dailyQuotaRemainingPercent: 65, weeklyQuotaRemainingPercent: 8,
    dailyQuotaResetAtUnix: Math.floor((Date.now() + 5 * 36e5) / 1000),
    weeklyQuotaResetAtUnix: 1901000000, planInfo: { planName: 'Pro' } } },
    planInfo: { planName: 'Pro' } });
  const s = setup({ credentials: creds, quota });
  await s.type.run(s.delivery());
  await flush(); await flush();
  const text = render(s.panel.component());
  assert.ok(text.includes('Renova em 5 horas ('));
});

test('quota also accepts a root-level planStatus without the userStatus envelope', async () => {
  const s = setup({ credentials: creds, quota: quotaBody('Pro', false) });
  await s.type.run(s.delivery());
  await flush(); await flush();
  const text = render(s.panel.component());
  assert.ok(text.includes('Limite diário:') && text.includes('65% restante'));
});

test('a connected Codex adds a second cluster beside Devin with its own windows', async () => {
  const s = setup({ credentials: creds, quota: quotaBody('Pro'),
    codexAuth: codexAuthBody, codexQuota: codexQuotaBody });
  await s.type.run(s.delivery());
  await flush(); await flush();
  const call = s.hostRequests.find(r => r.url.includes('chatgpt.com'));
  assert.equal(call.method, 'GET');
  assert.equal(call.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(call.headers.authorization, 'Bearer codex-token');
  assert.equal(call.headers['chatgpt-account-id'], 'acct-1');
  const text = render(s.panel.component());
  assert.ok(text.includes('Devin') && text.includes('Codex · Plus'));
  assert.ok(text.includes('Limite de 5 horas:') && text.includes('80% restante'));
  assert.ok(text.includes('Limite semanal:') && text.includes('45% restante'));
  assert.equal((text.match(/Atualizado/g) ?? []).length, 1);
  const toolbar = render(s.panel.toolbar());
  assert.ok(toolbar.includes('borderInlineStart') || toolbar.includes('border-inline-start'));
});

test('an expired Codex token falls back to the newest rollout rate_limits event', async () => {
  const s = setup({ credentials: creds, quota: quotaBody('Pro'),
    codexAuth: codexAuthBody, codexQuota: { status: 401, headers: {}, body: '{}' },
    commands: { 'codex-rollout': rolloutOut } });
  await s.type.run(s.delivery());
  await flush(); await flush();
  const text = render(s.panel.component());
  assert.ok(text.includes('Codex · Plus'));
  assert.ok(text.includes('Limite de 5 horas:') && text.includes('89% restante'));
  assert.ok(text.includes('Limite semanal:') && text.includes('67% restante'));
  assert.ok(text.includes('Dados da última sessão local'));
  assert.ok(text.includes('token expirado'));
});

test('an expired Codex token without a rollout degrades to grey rings and the reason', async () => {
  const s = setup({ codexAuth: codexAuthBody, codexQuota: { status: 401, headers: {}, body: '{}' },
    commands: { 'codex-rollout': null } });
  await s.type.run(s.delivery());
  await flush(); await flush();
  const text = render(s.panel.component());
  assert.ok(!text.includes('Devin ·'));
  assert.ok(text.includes('Não foi possível consultar os limites (token expirado'));
});

test('without credentials the indicator degrades instead of breaking the toolbar', async () => {
  const s = setup();
  assert.equal(s.panel.id, 'devin-quota');
  await s.type.run(s.delivery());
  await flush();
  const toolbar = render(s.panel.toolbar());
  assert.ok(toolbar.includes('Limites de uso'));
  assert.equal(s.hostRequests.length, 0);
  assert.ok(render(s.panel.component()).includes('Nenhum provider detectado'));
});
