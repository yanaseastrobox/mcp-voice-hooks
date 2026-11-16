import fs from 'fs';
import os from 'os';
import path from 'path';

const DEBUG = process.argv.includes('--debug') || process.argv.includes('-d') || process.env.MCP_VOICE_HOOKS_DEBUG === 'true';
const LOG_FILE = process.env.MCP_VOICE_HOOKS_LOG_FILE || path.join(os.tmpdir(), 'mcp-voice-hooks.log');

export function debugLog(...args: any[]): void {
  if (DEBUG) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ログ失敗は無視する。 */ }
  }
}
