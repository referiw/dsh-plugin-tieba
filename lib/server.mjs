/**
 * 设置页用的 HTTP 接口。挂在宿主 webServer 上，供客户端模块 fetch。
 *
 * 设计取舍：扫码不做百度二维码接口的逆向，直接开一个浏览器渲染登录页、截图返回。
 * 好处是页面自己会刷新二维码、自己会跳转，我们只负责截图和判定，行为与真人一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from './browser.mjs';
import { readConfig, writeConfig } from './config-store.mjs';
import { ensureHome } from './paths.mjs';
import { DESKTOP_UA } from './core.mjs';

const LOGIN_URL = 'https://passport.baidu.com/v2/?login&u=https%3A%2F%2Ftieba.baidu.com%2F';

let session = null; // { browser, ctx, page, startedAt }

/**
 * 仅限本机。
 *
 * 只看 remoteAddress 是不够的：gateway 反向代理转发时，连接同样来自 127.0.0.1，
 * 公网请求会被当成"本机"。所以叠加两条判据：
 *   ① 连接来自回环地址；
 *   ② 没有任何转发头（X-Forwarded-For / X-Real-IP / Forwarded）——出现即视为经代理而来。
 */
export function isLocalRequest(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!loopback) return false;
  const h = req.headers || {};
  if (h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded'] || h['x-forwarded-host']) return false;
  return true;
}

// 本插件对外只交流两种内容：application/json（文字）与 image/png（二维码）。
// 不提供任何文件下载、HTML 或其它二进制通道。

function sendText(req, res, code, obj) {
  if (!isLocalRequest(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'forbidden: local access only' }));
  }
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
  return { state: 'pending', url, ageMs: Date.now() - session.startedAt };
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

  reg('/tieba/api/login/qr.png', async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'forbidden: local access only' }));
      }
      if (!session) { res.writeHead(404); return res.end('no session'); }
      const buf = await shot();
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(buf);
    } catch (e) {
      res.writeHead(500); return res.end(String(e?.message || e));
    }
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
