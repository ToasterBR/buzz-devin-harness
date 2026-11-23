// Runs one tiny real Devin prompt. Uses the existing local login and may incur usage.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';
const child = spawn('devin', ['acp'], { env: { ...process.env, DEVIN_PERMISSION_MODE: 'auto' }, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let id = 0, text = '';
const lines = readline.createInterface({ input: child.stdout });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
child.stderr.resume(); // Runtime logs may include account data; do not echo them.
const write = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
lines.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk') text += m.params.update.content.text || '';
  if (m.method && m.id !== undefined) write({ id: m.id, ...(m.method === 'session/request_permission'
    ? { result: { outcome: { outcome: 'cancelled' } } }
    : { error: { code: -32601, message: 'Unsupported in smoke test' } }) });
  if (!m.method && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
child.on('error', e => { for (const p of pending.values()) p.reject(e); });
child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('Devin exited')); });
const rpc = (method, params) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); write({ id: next, method, params }); });
try {
  const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'buzz-devin-smoke', version: '0.1.0' } });
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentCapabilities.mcpCapabilities.http, true);
  const session = await rpc('session/new', { cwd: process.cwd(), mcpServers: [] });
  const result = await rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly OK. Do not use any tools or access any files.' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(text.trim(), 'OK');
  console.log('PASS: live ACP initialize → session/new → session/prompt → OK. No tools requested by the test.');
} finally { clearTimeout(timer); child.kill(); lines.close(); }
