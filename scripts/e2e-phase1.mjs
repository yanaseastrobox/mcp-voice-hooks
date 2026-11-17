import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本番のポート・状態ファイルには触れず、自分が起動したプロセスだけ終了する。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.MCP_VOICE_HOOKS_E2E_PORT || 15112);
assert(Number.isInteger(port) && port > 1024 && port <= 65535 && ![5111, 5112, 5113].includes(port));
const url = `http://127.0.0.1:${port}`;
const directory = fs.mkdtempSync(path.join(root, '.phase1-e2e-'));
const env = { ...process.env, MCP_VOICE_HOOKS_PORT: String(port), MCP_VOICE_HOOKS_BIND: '127.0.0.1',
  MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER: 'false', MCP_VOICE_HOOKS_DISABLE_HTTPS: 'true',
  MCP_VOICE_HOOKS_STATE_FILE: path.join(directory, 'state.json'),
  // ディレクトリへの書き込みを意図的に失敗させ、ログ例外の抑止も確認する。
  MCP_VOICE_HOOKS_LOG_FILE: directory, MCP_VOICE_HOOKS_DEBUG: 'true',
  MCP_VOICE_HOOKS_NO_TRANSCRIBE: 'true' };
const children = [];
const daemons = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body) {
  const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.equal(response.ok, true, `${route}: ${response.status}`);
  return response.json();
}
async function ready() {
  for (let i = 0; i < 400; i++) {
    try { const health = await api('/api/health'); daemons.add(health.pid); return health.pid; }
    catch { await delay(100); }
  }
  throw Error('daemon 起動タイムアウト');
}
function start(...args) {
  const child = spawn(process.execPath, [path.join(root, 'dist/unified-server.js'), ...args],
    { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', data => fs.appendFileSync(path.join(directory, 'stderr.log'), data));
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}
async function stopDaemon(pid) {
  assert(daemons.has(pid));
  process.kill(pid);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { daemons.delete(pid); return; }
    await delay(50);
  }
  throw Error('daemon 終了タイムアウト');
}
try {
  // 指定ポートに既存リスナーがあれば、そのプロセスには一切触れない。
  const net = await import('node:net');
  await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  const first = start('--mcp-managed');
  const second = start('--mcp-managed');
  const pid = await ready();
  await delay(500);
  assert.notEqual(pid, first.pid); assert.notEqual(pid, second.pid);
  await stop(first); await stop(second);
  assert.equal((await api('/api/health')).pid, pid);
  assert.equal((await api('/api/voice-responses')).enabled, true);
  await api('/api/voice-responses', { enabled: true });
  const abort = new AbortController();
  const stream = await fetch(url + '/api/tts-events', { signal: abort.signal });
  const reader = stream.body.getReader(); await reader.read(); abort.abort();
  await delay(100);
  const reconnect = new AbortController();
  const reconnected = await fetch(url + '/api/tts-events', { signal: reconnect.signal });
  await reconnected.body.getReader().read(); reconnect.abort();
  await api('/api/voice-active', { active: false });
  assert.equal((await api('/api/voice-responses')).enabled, true);
  console.log('PASS: 全クライアント切断・再接続・マイク停止後も読み上げON');

  const key = id => JSON.stringify([id, 'main']);
  await api('/api/hooks/user-prompt', { session_id: 'A', prompt: '会話開始', cwd: 'C:\\work\\案件A' });
  assert.equal((await api('/api/sessions')).activeKey, key('A'));
  await api('/api/hooks/user-prompt', { session_id: 'B', prompt: '会話開始', cwd: 'C:\\work\\案件B' });
  assert.equal((await api('/api/sessions')).activeKey, key('B'));
  await api('/api/hooks/post-tool', { session_id: 'C' });
  await api('/api/hooks/user-prompt', { session_id: 'C', prompt: '背景作業' });
  assert.equal((await api('/api/sessions')).activeKey, key('B'));
  // 途中のsystem-reminderを消して合言葉が成立してはならない。先頭のものだけ除く。
  await api('/api/hooks/user-prompt', { session_id: 'C', prompt: '音声<system-reminder>x</system-reminder>開始' });
  assert.equal((await api('/api/sessions')).activeKey, key('B'));
  await api('/api/hooks/user-prompt', { session_id: 'A', prompt: '<system-reminder>x</system-reminder>\n<system-reminder>y</system-reminder>\n音声会話開始' });
  assert.equal((await api('/api/sessions')).activeKey, key('A'));
  await api('/api/hooks/user-prompt', { session_id: 'B', prompt: '会話開始' });
  assert.equal((await api('/api/sessions')).activeKey, key('B'));
  assert.equal((await api('/api/sessions')).sessions.find(s => s.key === key('B')).displayName, '案件B');
  console.log('PASS: 明示会話開始でA→B、背景フックでは変更なし、表示名');
  const playback = new AbortController();
  const playbackStream = await fetch(url + '/api/tts-events', { signal: playback.signal });
  await playbackStream.body.getReader().read();
  await api('/api/hooks/post-tool', { session_id: 'B' });
  assert.match((await api('/api/hooks/stop', { session_id: 'B' })).reason, /speak/);
  await api('/api/potential-utterances', { text: 'keyboard', source: 'typed' });
  await api('/api/potential-utterances', { text: 'microphone', source: 'speech' });
  await api('/api/potential-utterances', { text: 'legacy' });
  const history = (await api('/api/conversation')).messages;
  assert.equal(history.find(message => message.text === 'keyboard').source, 'typed');
  assert.equal(history.find(message => message.text === 'microphone').source, 'speech');
  const result = await api('/api/hooks/post-tool', { session_id: 'B' });
  assert.match(result.reason, /typed input: "keyboard"/);
  assert.match(result.reason, /voice input: "microphone"/);
  assert.match(result.reason, /voice input: "legacy"/);
  assert.match((await api('/api/hooks/stop', { session_id: 'B' })).reason, /speak/);
  assert.match((await api('/api/hooks/post-tool', { session_id: 'B' })).reason, /speak/);
  console.log('PASS: 入力元をClaude向け文面まで保持、マイク停止中もspeak要求');

  playback.abort();
  await delay(150);
  for (const route of ['stop', 'post-tool']) {
    const result = await api('/api/hooks/' + route, { session_id: 'B' });
    assert.equal(result.decision, 'approve');
    assert.doesNotMatch(result.reason || '', /speak/);
  }
  assert.equal((await api('/api/validate-action', { action: 'stop' })).allowed, true);
  const unavailable = await fetch(url + '/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'offline' }) });
  assert.equal(unavailable.status, 503);
  assert.match((await unavailable.json()).error, /respond in text/);
  await api('/api/hooks/user-prompt', { session_id: 'B', prompt: 'First request\ncontinued', cwd: 'C:/work/projectB' });
  await api('/api/hooks/user-prompt', { session_id: 'B', prompt: 'Later request', cwd: 'C:/work/projectB' });
  assert.equal((await api('/api/sessions')).sessions.find(s => s.key === key('B')).displayName, 'First request continued — projectB');
  console.log('PASS: no-client enforcement disabled, speak error, first prompt preserved');
  await api('/api/voice-responses', { enabled: false });
  await stopDaemon(pid);
  const proxy = start('--mcp-managed');
  const restored = await ready();
  assert.equal((await api('/api/voice-responses')).enabled, false);
  assert.equal((await api('/api/sessions')).activeKey, null);
  await api('/api/hooks/post-tool', { session_id: 'C' });
  assert.equal((await api('/api/sessions')).activeKey, null);
  await api('/api/hooks/post-tool', { session_id: 'B' });
  assert.equal((await api('/api/sessions')).activeKey, key('B'));
  await api('/api/voice-responses', { enabled: true });
  await stopDaemon(restored);
  // speakを呼ばず、30秒の定期監視だけで復旧する。
  await ready();
  assert.equal((await api('/api/voice-responses')).enabled, true);
  console.log('PASS: 親終了後もdaemon存続、OFF/ON永続化、選択の遅延復元、定期監視で再起動');
  await stop(proxy);
  for (const ownedPid of daemons) await stopDaemon(ownedPid);
  const http = await import('node:http');
  const legacy = http.createServer((_req, res) => { res.writeHead(404); res.end('legacy'); });
  await new Promise(resolve => legacy.listen(port, '127.0.0.1', resolve));
  try {
    const forwarder = start('--mcp-managed');
    let output = '', errors = '';
    forwarder.stdout.on('data', data => { output += data; });
    forwarder.stderr.on('data', data => { errors += data; });
    forwarder.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) + '\n');
    for (let i = 0; i < 100 && !output.includes('"speak"'); i++) await delay(100);
    assert.match(output, /"speak"/);
    assert.match(errors, /legacy server.*daemon launch skipped/);
    assert.equal(forwarder.exitCode, null);
    // killせずstdinを閉じるだけで、転送役が自分で終了すること。
    const exited = once(forwarder, 'exit');
    forwarder.stdin.end();
    await Promise.race([exited, delay(5000).then(() => { throw Error('stdin終了後も転送役が残留'); })]);
    console.log('PASS: 旧版ポート占有時もMCPのspeakツールを維持、stdin終了で転送役が終了');
  } finally { await new Promise(resolve => legacy.close(resolve)); }
} finally {
  for (const child of children) await stop(child);
  for (const pid of daemons) await stopDaemon(pid);
  console.log(`検証ログ: ${directory}`);
}
