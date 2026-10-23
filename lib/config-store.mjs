/**
 * 配置存储：一个 JSON 文件，插件每次调用重新读（带 mtime 缓存）。
 * 这样设置页写完立即生效，也不用依赖宿主的 configForms 内部 API。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, COOKIE_FILE } from './paths.mjs';

export const CONFIG_PATH = CONFIG_FILE;

export const DEFAULTS_UI = {
  gapMs: 4000,
  sampleMode: 'dynamic',
  sampleMin: 50,
  sampleMax: 120,
  sampleFixed: 50,
  sampleRatio: 0.2,
  truncateText: true,
  maxTextChars: 600,
  imageQuality: 'thumb',
  imageMaxArea: 1200000,
  imageMaxWidth: 1280,
  imageMaxHeight: 2000,
  cacheTtlMs: 600000,
  maxPages: 30,
  cookieFile: COOKIE_FILE,
};

let _cache = null;
let _mtime = 0;

export function readConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (_cache && st.mtimeMs === _mtime) return _cache;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _cache = { ...DEFAULTS_UI, ...raw };
    _mtime = st.mtimeMs;
    return _cache;
  } catch {
    _cache = _cache || { ...DEFAULTS_UI };
    return _cache;
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  // 只接受已知键，避免设置页把脏数据写进来
  for (const k of Object.keys(next)) if (!(k in DEFAULTS_UI)) delete next[k];
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  _cache = next;
  try { _mtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch {}
  return next;
}
