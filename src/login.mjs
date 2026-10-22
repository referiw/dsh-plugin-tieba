#!/usr/bin/env node
/**
 * 通用扫码登录器：起一个真实 Chromium，打开登录页，截图给你扫，轮询到登录成功就把
 * 该域下的全部 cookie 落盘（0600）。不碰密码、不碰验证码。
 *
 * 用法：
 *   node login.mjs --site bili
 *   node login.mjs --site tieba
 *   node login.mjs --url https://x/login --domain x.com \
 *                  --check https://x/api/me --okPath data.isLogin [--okValue true]
 *
 * 退出码：0=登录成功  3=超时  1=启动失败
 */
import path from 'node:path';
import { chromium } from 'playwright';
import { PROFILE_DIR, COOKIE_FILE, HOME_DIR, ensureHome } from '../lib/paths.mjs';
import fs from 'node:fs';

const SITES = {
  bili: {
    url: 'https://passport.bilibili.com/login',
    domain: 'bilibili.com',
    check: 'https://api.bilibili.com/x/web-interface/nav',
    okPath: 'data.isLogin',
    okValue: true,
    label: 'B 站',
  },
  tieba: {
    url: 'https://passport.baidu.com/v2/?login&u=https%3A%2F%2Ftieba.baidu.com%2F',
    domain: 'baidu.com',
    check: 'https://tieba.baidu.com/dc/common/tbs',
    okPath: 'is_login',
    okValue: 1,
    label: '百度贴吧',
  },
};

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const site = arg('site', '');
const cfg = site ? SITES[site] : null;
if (site && !cfg) {
  console.error(`未知 site: ${site}（可选 ${Object.keys(SITES).join(', ')}）`);
  process.exit(1);
}

const URL_ = arg('url', cfg?.url);
const DOMAIN = arg('domain', cfg?.domain);
const CHECK = arg('check', cfg?.check);
const OKPATH = arg('okPath', cfg?.okPath);
const OKVAL = arg('okValue', cfg?.okValue ?? true);
ensureHome();
const SHOT = arg('shot', path.join(HOME_DIR, `login-${site || 'page'}.png`));
// tieba 的 cookie 直接落到内核读取的位置，省得再拷一次
const OUT = arg('out', site === 'tieba' ? COOKIE_FILE : path.join(HOME_DIR, `login-${site || 'page'}.cookies.json`));
const TIMEOUT_S = Number(arg('timeout', '600'));
const LABEL = cfg?.label ?? DOMAIN;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  viewport: { width: 1280, height: 900 },
  userAgent: UA,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
log(`打开${LABEL}登录页…`);
await page
  .goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 })
  .catch((e) => log('goto 警告: ' + e.message));
await page.waitForTimeout(5000);
await page.screenshot({ path: SHOT });
log(`已截图 → ${SHOT}`);

const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// 登录判定必须**同源**发起，否则跨域 fetch 会被 CORS 拦掉（百度就是栽在这上面：
// 页面停在 passport.baidu.com，去 fetch tieba.baidu.com 永远失败）。
let onCheckOrigin = false;

let lastShot = Date.now();
for (let i = 0; i < TIMEOUT_S / 2; i++) {
  await page.waitForTimeout(2000);
  const cookies = await ctx.cookies(`https://${DOMAIN}`).catch(() => []);
  if (cookies.length) {
    if (!onCheckOrigin) {
      const origin = new URL(CHECK).origin;
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      onCheckOrigin = true;
      log(`切到判定源：${origin}`);
    }
    const res = await page
      .evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' });
          return await r.json();
        } catch {
          return null;
        }
      }, CHECK)
      .catch(() => null);
    if (String(res ? pick(res, OKPATH) : undefined) === String(OKVAL)) {
      fs.writeFileSync(OUT, JSON.stringify(cookies, null, 2), { mode: 0o600 });
      await page.screenshot({ path: SHOT.replace(/\.png$/, '-done.png') }).catch(() => {});
      log(`LOGIN_OK site=${site || DOMAIN} cookies=${cookies.length} → ${OUT}`);
      await ctx.close();
      process.exit(0);
    }
  }
  if (Date.now() - lastShot > 30000) {
    await page.screenshot({ path: SHOT }).catch(() => {});
    lastShot = Date.now();
    log('刷新截图');
  }
}
log('TIMEOUT 未在时限内完成登录');
await ctx.close();
process.exit(3);
