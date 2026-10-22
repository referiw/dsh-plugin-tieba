/**
 * 浏览器定位。
 *
 * 为什么要浏览器：贴吧的 HTML 页面有 TLS/HTTP 指纹校验，纯 fetch 拿到的是
 * 「百度安全验证」403；楼层页必须由真实浏览器引擎渲染。但"必须用浏览器"不等于
 * "必须用某个版本的浏览器"——Chromium 系的 CDP 协议跨若干版本是兼容的，
 * 所以这里直接扫描磁盘上**已经存在**的浏览器，不要求它和 playwright-core 的
 * 版本号严格对应。
 *
 * 解析顺序（第一个能启动的胜出，结果记忆下来避免反复试错）：
 *   1. DSH_TIEBA_CHROME 指定的可执行文件
 *   2. ms-playwright 目录里已装的 headless shell / chromium（新版本优先，不论 revision）
 *   3. Playwright 按自身版本解析的那个（装了就走这里）
 *   4. 系统 Chrome / Edge / Chromium
 *
 * 全都不满足时给一条能照做的报错，而不是 "Executable doesn't exist"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

/** 已确认可用的启动方式；null 表示还没探测过。 */
let strategy = null;

const SYSTEM = [
  { kind: 'chrome', opts: { channel: 'chrome' } },
  { kind: 'msedge', opts: { channel: 'msedge' } },
  { kind: 'chromium', opts: { channel: 'chromium' } },
];

const SHELL_REL = [
  'chrome-headless-shell-win64/chrome-headless-shell.exe',
  'chrome-linux/chrome-headless-shell',
  'chrome-headless-shell-mac/chrome-headless-shell',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
];
const FULL_REL = [
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
  'chrome-linux/chrome',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
];

/** Playwright 的浏览器缓存目录（可用 PLAYWRIGHT_BROWSERS_PATH 覆盖）。 */
function browsersRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

/** 扫盘：把已装的 chromium 系可执行文件按 revision 从新到旧列出来。 */
function installedBrowsers() {
  const root = browsersRoot();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }

  const revision = (name) => Number((/-(\d+)$/.exec(name) || [])[1] || 0);
  const found = [];
  for (const name of names) {
    const isShell = name.startsWith('chromium_headless_shell-');
    const isFull = !isShell && name.startsWith('chromium-');
    if (!isShell && !isFull) continue;
    for (const rel of isShell ? SHELL_REL : FULL_REL) {
      const exe = path.join(root, name, rel);
      if (fs.existsSync(exe)) {
        found.push({ kind: name, opts: { executablePath: exe }, rev: revision(name), shell: isShell });
        break;
      }
    }
  }
  // headless shell 优先（体积小、无需 GPU），同类型里新版本优先
  found.sort((a, b) => (Number(b.shell) - Number(a.shell)) || (b.rev - a.rev));
  return found.map(({ kind, opts }) => ({ kind, opts }));
}

function candidates() {
  const list = [];
  const explicit = process.env.DSH_TIEBA_CHROME;
  if (explicit) list.push({ kind: 'DSH_TIEBA_CHROME=' + explicit, opts: { executablePath: explicit } });
  list.push(...installedBrowsers());
  // 让 Playwright 按它自己解析的路径试一次（覆盖 PLAYWRIGHT_BROWSERS_PATH 等自定义布局）
  list.push({ kind: 'playwright-default', opts: {} });
  return list.concat(SYSTEM);
}

function instruction() {
  return [
    '找不到可用的浏览器。这个插件需要真实浏览器引擎（贴吧的页面有指纹校验，纯 HTTP 会被拦）。',
    '两种办法，任选一种：',
    '  1. 装一份独立 headless shell（下载约 118 MB）：',
    '       npx playwright-core install chromium --only-shell',
    '  2. 用系统已有的浏览器（0 MB）：Windows/macOS 一般自带 Edge 或 Chrome；',
    '     Linux：apt install chromium；也可以用 DSH_TIEBA_CHROME=/path/to/chrome 指定。',
  ].join('\n');
}

async function launchWith(opts, extra) {
  return chromium.launch({ ...opts, ...extra, args: ARGS });
}

/**
 * 启动一个 Chromium 系浏览器。
 * @param {{ proxy?: string }} options - 出口代理（贴吧风控时可换 IP）。
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchChromium({ proxy } = {}) {
  const extra = proxy ? { proxy: { server: proxy } } : {};

  if (strategy) {
    try {
      return await launchWith(strategy.opts, extra);
    } catch {
      strategy = null; // 缓存的浏览器没了（卸载/升级）：重新探测
    }
  }

  for (const c of candidates()) {
    try {
      const browser = await launchWith(c.opts, extra);
      strategy = c;
      return browser;
    } catch { /* 试下一个 */ }
  }

  throw new Error(instruction());
}

/** 诊断用：报告当前会选中哪个浏览器。 */
export async function describeBrowser() {
  try {
    const browser = await launchChromium();
    const version = browser.version();
    const kind = strategy && strategy.kind;
    await browser.close();
    return { ok: true, kind, version };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
