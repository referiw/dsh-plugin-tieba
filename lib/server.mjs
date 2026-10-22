/**
 * 设置页用的 HTTP 接口。挂在宿主 webServer 上，供客户端模块 fetch。
 *
 * 设计取舍：扫码不做百度二维码接口的逆向，直接开一个浏览器渲染登录页、截图返回。
 * 好处是页面自己会刷新二维码、自己会跳转，我们只负责截图和判定，行为与真人一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { launchChromium } from './browser.mjs';
import { readConfig, writeConfig } from './config-store.mjs';
import { ensureHome } from './paths.mjs';
import { DESKTOP_UA } from './core.mjs';

const LOGIN_URL = 'https://passport.baidu.com/v2/?login&u=https%3A%2F%2Ftieba.baidu.com%2F';

let session = null; // { browser, ctx, page, startedAt }
let lastQrHash = null; // 上一帧二维码的指纹，用于跳过重复下发

/**
 * 哪些请求可以访问设置页接口。
 *
 * 策略照抄 DSH 自己的 `/api` 信任栅栏（`dsh-client-connection` 的 `isTrustedApiRequest`，
 * 没有导出，所以在这里等价实现一份）：**信 Host，不信 remoteAddress**。
 *
 * 1. Host 必须是回环地址，或在 `DSH_TIEBA_TRUSTED_HOST` 里显式放行的域名；
 * 2. `sec-fetch-site: cross-site` 一律拒绝（浏览器不允许页面伪造这个头）；
 * 3. 带 `Origin` 时必须和 Host 同源。
 *
 * 为什么不看 remoteAddress / X-Forwarded-For：反向代理后面所有请求都来自 127.0.0.1，
 * 按连接地址判会把公网请求误当本机（这正是公网部署时设置页 403 的原因）。
 * 为什么不只信 `sec-fetch-site`：那样任何解析到本机的域名都能过，挡不住 DNS rebinding；
 * 而 Host 白名单是显式配置，rebinding 拿不到它。
 */
const TRUSTED_HOSTS = (process.env.DSH_TIEBA_TRUSTED_HOST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isLoopbackHostname(name) {
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

export function isLocalRequest(req) {
  const h = req.headers || {};
  const host = h.host;
  if (!host) return false;

  let hostUrl;
  try { hostUrl = new URL('http://' + host); } catch { return false; }
  const hostname = hostUrl.hostname.toLowerCase();
  const trusted = TRUSTED_HOSTS.some((t) => t === host.toLowerCase() || t === hostname);
  if (!isLoopbackHostname(hostname) && !trusted) return false;

  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;

  const origin = h.origin;
  if (origin === undefined) return true; // 非浏览器客户端（curl / 脚本）
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// 本插件对外只交流两种内容：application/json（文字）与 image/png（二维码）。
// 不提供任何文件下载、HTML 或其它二进制通道。

function forbidden(res, req) {
  const host = (req.headers || {}).host || '';
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    error: 'forbidden: untrusted host',
    host,
    // 把解决办法直接回给前端，省得用户去翻文档
    hint: host
      ? `公网/反代部署需要放行这个域名：设置环境变量 DSH_TIEBA_TRUSTED_HOST=${host} 后重启 DSH`
      : '请求缺少 Host 头',
  }));
}

function sendText(req, res, code, obj) {
  if (!isLocalRequest(req)) return forbidden(res, req);
  return json(res, code, obj);
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startLogin() {
  await stopLogin();
  const browser = await launchChromium();
  const ctx = await browser.newContext({
    // 桌面视口：百度移动版登录页的二维码在折叠线以下，截不到
    userAgent: DESKTOP_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 },
  });
  // 带上已有 cookie，已登录时页面会直接跳走
  try {
    const raw = JSON.parse(fs.readFileSync(readConfig().cookieFile, 'utf8'));
    await ctx.addCookies(raw.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      expires: c.expires && c.expires > 0 ? c.expires : -1,
      httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
    })));
  } catch {}
  const page = await ctx.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  session = { browser, ctx, page, startedAt: Date.now() };
  return session;
}

async function stopLogin() {
  if (!session) return;
  try { await session.browser.close(); } catch {}
  session = null;
  lastQrHash = null;
}

async function shot() {
  if (!session) throw new Error('no_session');
  // 优先只截二维码元素；找不到就退回整页
  for (const sel of ['[class*="qrcode"]', '[class*="qr-code"]', '[class*="QRCode"]', 'canvas', 'img[src*="qr"]']) {
    try {
      const loc = session.page.locator(sel).first();
      if (await loc.count()) {
        const box = await loc.boundingBox();
        if (box && box.width > 80 && box.height > 80) {
          return await loc.screenshot({ type: 'png' });
        }
      }
    } catch {}
  }
  return await session.page.screenshot({ type: 'png' });
}

async function poll() {
  if (!session) return { state: 'idle' };
  const cookies = await session.ctx.cookies('https://tieba.baidu.com').catch(() => []);
  const bduss = cookies.find((c) => c.name === 'BDUSS' && c.value);
  const url = session.page.url();
  const onLoginPage = /passport\.baidu\.com|wappass/.test(url);
  if (bduss && !onLoginPage) {
    const raw = await session.ctx.cookies().catch(() => []);
    const file = readConfig().cookieFile;
    try {
      // 首次登录时 ~/.dsh-tieba/ 还不存在：不建目录的话这一步会 ENOENT，
      // 前端只看到 500，扫码成功后界面永远不会变成"已登录"。
      ensureHome();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
    } catch (e) {
      await stopLogin();
      return { state: 'error', error: '保存 cookie 失败：' + String((e && e.message) || e) };
    }
    await stopLogin();
    return { state: 'ok' };
  }
  if (/验证|captcha/.test(url)) return { state: 'captcha', url };
  const out = { state: 'pending', url, ageMs: Date.now() - session.startedAt };
  // 二维码直接放进轮询响应，不再单独开一条 <img> 路由：
  // 那条路由带不了请求头、出错只能显示破图，也不适合以后加鉴权。
  // 只有画面变了才带上，避免每 2 秒重复传同一张图。
  try {
    const buf = await shot();
    const hash = createHash('sha1').update(buf).digest('hex');
    if (hash !== lastQrHash) {
      lastQrHash = hash;
      out.qr = 'data:image/png;base64,' + buf.toString('base64');
    }
  } catch { /* 这一帧截不到就等下一轮 */ }
  return out;
}

/** 注册全部路由；返回 disposer 数组。 */
export function installRoutes(webServer) {
  if (!webServer || typeof webServer.register !== 'function') return [];
  const disposers = [];
  const reg = (path, handler) => {
    try { disposers.push(webServer.register({ kind: 'exact', path, handler })); } catch {}
  };

  reg('/tieba/api/config', async (req, res) => {
    try {
      if (req.method === 'GET') return sendText(req, res, 200, readConfig());
      if (req.method === 'POST') {
        const body = await readBody(req);
        const patch = JSON.parse(body || '{}');
        return sendText(req, res, 200, writeConfig(patch));
      }
      return sendText(req, res, 405, { error: 'method not allowed' });
    } catch (e) {
      return sendText(req, res, 500, { error: String(e?.message || e) });
    }
  });

  reg('/tieba/api/status', async (req, res) => {
    try {
      const { Tieba } = await import('./core.mjs');
      const tb = new Tieba({ cookieFile: readConfig().cookieFile });
      try { return sendText(req, res, 200, await tb.status()); }
      finally { await tb.close(); }
    } catch (e) {
      return sendText(req, res, 500, { error: String(e?.message || e) });
    }
  });

  reg('/tieba/api/login/start', async (req, res) => {
    if (req.method !== 'POST') return sendText(req, res, 405, { error: 'method not allowed' });
    try { await startLogin(); return sendText(req, res, 200, { state: 'ready' }); }
    catch (e) { return sendText(req, res, 500, { error: String(e?.message || e) }); }
  });

  reg('/tieba/api/login/poll', async (req, res) => {
    try { return sendText(req, res, 200, await poll()); }
    catch (e) { return sendText(req, res, 500, { error: String(e?.message || e) }); }
  });

  reg('/tieba/api/login/cancel', async (req, res) => {
    await stopLogin();
    return sendText(req, res, 200, { state: 'idle' });
  });

  return disposers;
}
