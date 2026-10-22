/**
 * 浏览器定位：优先用系统里已经装好的 Chrome / Edge，不再下载 Playwright 自带的 Chromium。
 *
 * 为什么要浏览器：贴吧的 HTML 页面有 TLS/HTTP 指纹校验，纯 fetch 拿到的是
 * 「百度安全验证」403；楼层页必须由真实浏览器引擎渲染。但"必须用浏览器"不等于
 * "必须用 Playwright 下载的那一份"——系统浏览器同样能跑。
 *
 * 解析顺序（第一个能启动的胜出，结果记忆下来避免反复试错）：
 *   1. DSH_TIEBA_CHROME 指定的可执行文件
 *   2. 系统 Chrome   (channel: chrome)
 *   3. 系统 Edge     (channel: msedge)
 *   4. 系统 Chromium (channel: chromium)
 *   5. 若用户自己另装了完整版 playwright（带浏览器），退回它自带的 Chromium
 *
 * 全都不满足时给一条能照做的报错，而不是 "Executable doesn't exist"。
 */
import { chromium } from 'playwright-core';

const ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

/** 已确认可用的启动方式；null 表示还没探测过。 */
let strategy = null;

const COMMON = [
  { kind: 'chrome', opts: { channel: 'chrome' } },
  { kind: 'msedge', opts: { channel: 'msedge' } },
  { kind: 'chromium', opts: { channel: 'chromium' } },
];

function candidates() {
  const list = [];
  const explicit = process.env.DSH_TIEBA_CHROME;
  if (explicit) list.push({ kind: 'DSH_TIEBA_CHROME=' + explicit, opts: { executablePath: explicit } });
  return list.concat(COMMON);
}

/** 完整版 playwright（用户自己装的）——有就用，没有就算了。 */
async function bundled() {
  try {
    const mod = await import('playwright');
    const browser = await mod.chromium.launch({ args: ARGS });
    return { browser, kind: 'playwright-bundled' };
  } catch {
    return null;
  }
}

function instruction() {
  return [
    '找不到可用的浏览器。这个插件需要真实浏览器引擎（贴吧的页面有指纹校验，纯 HTTP 会被拦）。',
    '三种解决办法，任选一种：',
    '  1. 装 Chrome 或 Edge（Windows 自带 Edge，通常已经有了）；',
    '  2. Linux 服务器：apt install chromium（或 chromium-browser）；',
    '  3. 指定已有浏览器：export DSH_TIEBA_CHROME=/path/to/chrome',
  ].join('\n');
}

/**
 * 启动一个 Chromium 系浏览器。
 * @param {{ proxy?: string }} options - 出口代理（贴吧风控时可换 IP）。
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchChromium({ proxy } = {}) {
  const extra = proxy ? { proxy: { server: proxy } } : {};

  if (strategy) {
    return chromium.launch({ ...strategy.opts, ...extra, args: ARGS });
  }

  for (const c of candidates()) {
    try {
      const browser = await chromium.launch({ ...c.opts, ...extra, args: ARGS });
      strategy = c;
      return browser;
    } catch { /* 试下一个 */ }
  }

  const b = await bundled();
  if (b) {
    strategy = { kind: 'playwright-bundled', opts: {} };
    return b.browser;
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
