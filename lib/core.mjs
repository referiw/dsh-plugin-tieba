/**
 * 贴吧内核：登录状态、全量拉取、动态抽样、图片压缩、结构化输出。
 *
 * 三条硬约束（都是实测撞出来的）：
 *  1. 裸 cookie 重放无效——百度把会话绑在浏览器指纹上，只能借真实浏览器。
 *  2. 翻页必须"一页一会话"——同一上下文连续翻页会被判成机器人。
 *  3. 出口 IP 会被临时限流——遇验证码时自动换出口并在稍后重试，不暴露给用户。
 */
import { launchChromium } from './browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COOKIE_FILE, CACHE_DIR, IMAGE_DIR, PROFILE_DIR } from './paths.mjs';

const pexec = promisify(execFile);

export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const DEFAULTS = {
  profileDir: PROFILE_DIR,
  cookieFile: COOKIE_FILE,
  cacheDir: CACHE_DIR,
  imageDir: IMAGE_DIR,
  gapMs: 4000,            // 请求间隔（节流）
  maxPages: 30,           // 单个帖最多抓多少页（防止失控）
  retries: 3,             // 每页遇到验证码的重试次数
  // 出口回退链：第一个失败就换下一个。内建，不需要用户关心。
  egress: ['direct', 'http://127.0.0.1:7890'],
  // 抽样
  sampleMode: 'dynamic',  // dynamic | fixed | ratio | all
  sampleFixed: 0,         // fixed 模式下的层数
  sampleRatio: 0,         // ratio 模式下的比例
  sampleMin: 50,
  sampleMax: 120,         // 300 层整吞是上下文灾难；需要更多请在设置页调
  // 正文
  truncateText: true,     // 单层默认截断：够判断，不烧上下文
  maxTextChars: 600,      // 0 = 不截断
  // 图片
  imageQuality: 'thumb',   // thumb | original | both —— 默认只下缩略图
  // 吧内列表的选择器：贴吧前端改版时改这里，不用等发版
  selectors: {
    barRow: '.thread-card',
    barTitleLink: 'a.thread-content-link',
    barTitle: '.thread-title',
    barAuthor: 'a.head-name',
    barTopRow: '.top-thread-card',
    barTopLink: 'a[href*="/p/"]',
  },
  imageMaxArea: 1_200_000, // 像素面积上限，超出则等比缩小（约 1280x938）
  imageMaxWidth: 1280,
  imageMaxHeight: 2000,
  cacheTtlMs: 10 * 60 * 1000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 对外展示的路径。
 *
 * 默认给**绝对路径**：agent 拿到的路径要能直接丢给读文件/读图工具。`~` 不会被那些
 * 工具展开（实测会被当成 cwd 下的字面目录 `./~`），相对家目录的写法又只在 cwd 恰好
 * 是家目录时才成立。绝对路径在任何 cwd 下都可用，代价是输出里带用户名。
 *
 * `DSH_TIEBA_PATH_STYLE` 可切换：
 *   - 不设 / `abs`：绝对路径（默认）
 *   - `rel`：相对**当前工作目录**——cwd 是 agent 的落脚点，工具一定认，且不含用户名
 *   - `home`：`~/...`——最短，但需要调用方自己展开 `~`
 */
export function displayPath(p) {
  const abs = String(String(p || ''));
  const style = String(process.env.DSH_TIEBA_PATH_STYLE || 'abs').toLowerCase();
  if (style !== 'home' && style !== 'rel') return abs;

  // Windows 的 path.join 产出 `\`，统一换成 `/` 再比前缀
  const posix = (s) => s.split(path.sep).join('/');
  const rel = posix(abs);

  if (style === 'rel') {
    let cwd = '';
    try { cwd = posix(process.cwd()); } catch { return abs; }
    if (!cwd || cwd === '/') return abs;
    if (rel === cwd) return '.';
    if (rel.startsWith(cwd + '/')) return rel.slice(cwd.length + 1);
    return abs;
  }

  const homePosix = posix(os.homedir());
  // `~` 永远指用户家目录；贴吧自己的目录在它下面，所以只剩这一条分支
  if (homePosix && rel.startsWith(homePosix + '/')) return '~/' + rel.slice(homePosix.length + 1);
  if (homePosix && rel === homePosix) return '~';
  return abs;
}

const SH = 'Asia/Shanghai';

/** 把贴吧的各种时间写法归一成 `YYYY-MM-DD HH:MM`（东八区）。认不出来就原样返回。 */
export function formatPostedAt(raw, now = Date.now()) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const fmt = (ts) => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    // sv-SE 的格式正好是 YYYY-MM-DD HH:MM
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: SH, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d).slice(0, 16);
  };

  // 已带年份：2023-05-01 12:00
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) {
    return fmt(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${(m[4] || '00').padStart(2, '0')}:${m[5] || '00'}:00+08:00`);
  }

  // 省略年份：10-22 12:22 —— 算作今年；若落在未来（跨年），减一年
  m = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) {
    const thisYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: SH, year: 'numeric' }).format(new Date(now)));
    for (const y of [thisYear, thisYear - 1]) {
      const iso = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T${(m[3] || '00').padStart(2, '0')}:${m[4] || '00'}:00+08:00`;
      const ts = Date.parse(iso);
      if (!Number.isNaN(ts) && ts <= now + 36 * 3600e3) return fmt(ts);
    }
    return s;
  }

  // 相对时间
  if (s === '刚刚') return fmt(now);
  m = /^(\d+)\s*(分钟|小时|天)前$/.exec(s);
  if (m) {
    const unit = { 分钟: 60e3, 小时: 3600e3, 天: 86400e3 }[m[2]];
    return fmt(now - Number(m[1]) * unit);
  }
  m = /^昨天(?:\s*(\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) {
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: SH, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(now - 86400e3));
    return fmt(`${ymd}T${(m[1] || '00').padStart(2, '0')}:${m[2] || '00'}:00+08:00`);
  }

  return s;
}

export class Tieba {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.browser = null;
    this._lastNav = 0;
  }

  // ── 浏览器生命周期（插件常驻时复用）──────────────────────────
  async #browserFor(egress) {
    if (this.browser) return this.browser;
    this.browser = await launchChromium({
      ...(egress && egress !== 'direct' ? { proxy: egress } : {}),
    });
    return this.browser;
  }

  async close() {
    if (this.browser) { await this.browser.close(); this.browser = null; }
  }

  #cookies() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cfg.cookieFile, 'utf8'));
      return raw.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        expires: c.expires && c.expires > 0 ? c.expires : -1,
        httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
      }));
    } catch { return []; }
  }

  #cookieHeader() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cfg.cookieFile, 'utf8'));
      return raw.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch { return ''; }
  }

  // ── 登录状态 ────────────────────────────────────────────────
  async status() {
    const cookies = this.#cookies();
    if (!cookies.length) {
      return { loggedIn: false, reason: 'no_cookie', hint: '需要扫码登录一次' };
    }
    // 注意：不能用 /dc/common/tbs 判定——它会 301 跳到 http://，而 BDUSS 是 Secure cookie，
    // 走 http 不发送，结果永远是未登录。只能像真人一样打开页面看 DOM。
    const browser = await this.#browserFor('direct');
    // 登录态只在**桌面版**首页可见（侧栏"我关注的吧"）；移动版首页是信息流，看不出来。
    const ctx = await browser.newContext({
      userAgent: DESKTOP_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 900 },
    });
    try {
      await ctx.addCookies(cookies).catch(() => {});
      const page = await ctx.newPage();
      await page.goto('https://tieba.baidu.com/index.html', {
        waitUntil: 'domcontentloaded', timeout: 45000,
      }).catch(() => {});
      await page.waitForTimeout(2500);
      // 用户信息走贴吧自己的同源接口，比扒 DOM 稳
      const info = await page.evaluate(async () => {
        try {
          const r = await fetch('/f/user/json_userinfo', { credentials: 'include' });
          const j = await r.json();
          return j && j.data ? j.data : null;
        } catch (e) { return null; }
      }).catch(() => null);

      const probe = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const nameEl = document.querySelector('.user_name, [class*="user_name"], [class*="nickname"]');
        return {
          loggedIn: /我关注的吧|我常逛的吧/.test(text),
          loggedOut: /^(登录|立即登录)/m.test(text) && !/我关注的吧/.test(text),
          name: nameEl ? (nameEl.innerText || '').trim().split('\n')[0] : null,
          url: location.href,
        };
      });
      const portrait = info?.user_portrait || null;
      return {
        loggedIn: probe.loggedIn,
        reason: probe.loggedIn ? 'ok' : probe.loggedOut ? 'expired' : 'unknown',
        // 贴吧 ID（登录名）与昵称是两个东西，都返回
        user: info?.user_name_url || probe.name || null,
        nickname: info?.user_name_show || info?.show_nickname || null,
        avatar: portrait ? `https://himg.bdimg.com/sys/portrait/item/${portrait}` : null,
        cookieFile: this.cfg.cookieFile,
        hint: probe.loggedIn ? null : 'cookie 已失效，需要重新扫码登录',
      };
    } catch (e) {
      return { loggedIn: false, reason: 'network', error: String(e?.message || e) };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ── 关注的吧 ────────────────────────────────────────────────
  async bars() {
    const browser = await this.#browserFor('direct');
    const ctx = await browser.newContext({
      userAgent: DESKTOP_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 900 },
    });
    try {
      await ctx.addCookies(this.#cookies()).catch(() => {});
      const page = await ctx.newPage();
      await page.goto('https://tieba.baidu.com/index.html', {
        waitUntil: 'domcontentloaded', timeout: 45000,
      }).catch(() => {});
      await page.waitForTimeout(3000);
      const list = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/f?kw="]')) {
          const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 20) continue;
          let kw = (a.getAttribute('href') || '').split('kw=')[1] || '';
          kw = kw.split('&')[0];
          try { kw = decodeURIComponent(kw); } catch {}
          try { kw = decodeURIComponent(kw); } catch {}
          if (!kw || seen.has(kw)) continue;
          seen.add(kw);
          out.push(kw);
        }
        return out;
      });
      return list;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ── 吧内帖子列表（发现层）────────────────────────────────
  /**
   * 拉一个吧的帖子列表。
   *
   * 贴吧没有可用的公开 JSON 列表接口（`/c/f/frs/page` 返回 error_code 110001），
   * 只能读渲染后的 DOM。前端改版频繁，所以选择器做成配置项：
   * 默认值就是当前实测可用的那套，失效时改 config.selectors 即可，不用发版。
   */
  async bar(kw, { tab = null, page = 1 } = {}) {
    const browser = await this.#browserFor('direct');
    const ctx = await browser.newContext({
      userAgent: DESKTOP_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      viewport: { width: 1400, height: 1200 },
    });
    try {
      const cookies = this.#cookies();
      if (cookies.length) await ctx.addCookies(cookies).catch(() => {});
      const p = await ctx.newPage();
      const pn = Math.max(0, (Number(page) || 1) - 1) * 50;
      await p.goto(`https://tieba.baidu.com/f?kw=${encodeURIComponent(kw)}&ie=utf-8&pn=${pn}`, {
        waitUntil: 'domcontentloaded', timeout: 60000,
      });
      const sel = { ...DEFAULTS.selectors, ...(this.cfg.selectors || {}) };
      await p.waitForSelector(sel.barRow, { timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(1500);
      if (tab) {
        await p.evaluate((t) => {
          const el = [...document.querySelectorAll('a,div,span')]
            .find((e) => e.children.length === 0 && (e.textContent || '').trim() === t);
          if (el) el.click();
        }, tab).catch(() => {});
        await p.waitForTimeout(2500);
      }
      // 列表是虚拟滚动，节点会被回收：边滚边抽，按 tid 去重累积
      const seen = new Map();
      let stall = 0;
      for (let i = 0; i < 10 && seen.size < 30; i++) {
        const batch = await p.evaluate(BAR_IN_PAGE, sel).catch(() => []);
        const before = seen.size;
        for (const t of batch) if (!seen.has(t.tid)) seen.set(t.tid, t);
        stall = seen.size === before ? stall + 1 : 0;
        if (stall >= 2) break;
        // 列表在自己的滚动容器里（.frs-page-wrap），滚 window 没用
        await p.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 400);
          if (el) el.scrollTop += 1600; else window.scrollBy(0, 1600);
        }).catch(() => {});
        await p.waitForTimeout(900);
      }
      const rows = [...seen.values()].map((r) => ({ ...r, lastReplyAt: formatPostedAt(r.lastReplyAt) || r.lastReplyAt }));
      return { kw, tab, page: Number(page) || 1, more: rows.length >= 20, threads: rows };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ── 原图：桌面页带签名的 pic/item 地址，按文件名对齐并用同一上下文下载 ──
  /**
   * 移动页只给 250px 缩略图；桌面页的 `img` 带有效签名，能取到原图。
   * 两边文件名一致，所以用文件名把缩略图对回原图。
   * 注意必须用**浏览器请求上下文**下载：Node 的 fetch 没指纹，签名地址会返回 238x238 占位图。
   */
  async #fetchOriginals(tid, wanted) {
    if (!wanted.length) return new Map();
    const browser = await this.#browserFor('direct');
    const ctx = await browser.newContext({
      userAgent: DESKTOP_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      viewport: { width: 1400, height: 1200 },
    });
    try {
      const cookies = this.#cookies();
      if (cookies.length) await ctx.addCookies(cookies).catch(() => {});
      const p = await ctx.newPage();
      await p.goto(`https://tieba.baidu.com/p/${tid}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(4000);
      // 桌面页是懒加载：先滚几屏，把后面的图逼出来
      for (let i = 0; i < 6; i++) {
        await p.evaluate(() => {
          window.scrollBy(0, 1400);
          const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 400);
          if (el) el.scrollTop += 1400;
        }).catch(() => {});
        await p.waitForTimeout(800);
      }
      const urls = await p.evaluate(() => [...document.querySelectorAll('img')]
        .flatMap((i) => [i.getAttribute('src') || '', i.getAttribute('data-src') || '', i.getAttribute('data-original') || ''])
        .filter((s) => /tiebapic\.baidu\.com\/forum\/pic\/item/.test(s)));
      const byName = new Map();
      for (const u of urls) {
        const n = decodeURIComponent(String(u).split('?')[0].split('/').pop() || '');
        if (n && !byName.has(n)) byName.set(n, u);
      }
      const got = new Map();
      for (const { name, dest } of wanted) {
        const u = byName.get(name);
        if (!u) continue;
        try {
          const r = await ctx.request.get(u, { headers: { referer: `https://tieba.baidu.com/p/${tid}` } });
          if (!r.ok()) continue;
          const buf = await r.body();
          // 占位图只有几 KB，真图通常几十 KB 以上
          if (buf.length < 6000) continue;
          fs.writeFileSync(dest, buf);
          got.set(name, u);
          await sleep(300);
        } catch { /* 单张失败不影响其它图 */ }
      }
      return got;
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  // ── 单页抓取（一页一会话 + 出口回退 + 退避重试）─────────────
  async #fetchFloorPage(tid, off, egress) {
    const browser = await this.#browserFor(egress);
    const ctx = await browser.newContext({
      userAgent: MOBILE_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      viewport: { width: 430, height: 950 },
    });
    const cookies = this.#cookies();
    if (cookies.length) await ctx.addCookies(cookies).catch(() => {});
    const page = await ctx.newPage();
    try {
      await page.goto(`https://tieba.baidu.com/mo/q/m?kz=${tid}&pn=${off}`, {
        waitUntil: 'domcontentloaded', timeout: 60000,
      }).catch(() => {});
      await page.waitForTimeout(2200);
      const captcha = /wappass|captcha/i.test(page.url());
      if (captcha) return { captcha: true, rows: [], pages: 0 };
      const out = await page.evaluate(GRAB_IN_PAGE);
      const pagerTxt = await page.evaluate(() => document.querySelector('.j_pager_input')?.value || '');
      const pages = Number((/\/(\d+)\s*$/.exec(pagerTxt) || [])[1] || 0);
      return { captcha: false, rows: out, pages };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async #fetchPageWithRetry(tid, off) {
    const chain = this.cfg.egress?.length ? this.cfg.egress : ['direct'];
    let last = null;
    for (let attempt = 0; attempt < this.cfg.retries; attempt++) {
      const egress = chain[attempt % chain.length];
      await sleep(this.cfg.gapMs);
      last = await this.#fetchFloorPage(tid, off, egress).catch((e) => ({ captcha: true, error: String(e) }));
      if (!last.captcha) return { ...last, egress };
      // 验证码：退避后换下一个出口
      await sleep(1500 * (attempt + 1));
    }
    throw new Error(`第 ${off / 30 + 1} 页连续 ${this.cfg.retries} 次被拦截（最后一次出口 ${last?.egress || '?'}）`);
  }

  // ── 全量拉取（分页校验 + 缓存 TTL + 增量）───────────────────
  async pull(tid, { refresh = false, maxPages = this.cfg.maxPages } = {}) {
    const cacheFile = path.join(this.cfg.cacheDir, `${tid}.json`);
    fs.mkdirSync(this.cfg.cacheDir, { recursive: true });

    let cached = null;
    if (!refresh && fs.existsSync(cacheFile)) {
      try {
        const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const fresh = Date.now() - Date.parse(d.pulledAt) < this.cfg.cacheTtlMs;
        if (fresh && d.pages === 'complete') cached = d;
      } catch {}
    }
    if (cached) return { ...cached, fromCache: true };

    const floors = [];
    const seen = new Set();
    let declaredPages = 0;
    let stopped = null;
    let firstEgress = null;

    for (let off = 0, pgNo = 1; pgNo <= maxPages; off += 30, pgNo++) {
      const r = await this.#fetchPageWithRetry(tid, off);
      if (r.egress && !firstEgress) firstEgress = r.egress;
      if (r.pages) declaredPages = r.pages;
      const fresh = r.rows.filter((x) => !x.pid || !seen.has(x.pid));
      fresh.forEach((x) => { if (x.pid) seen.add(x.pid); });
      floors.push(...fresh);

      // 分页校验：以页面声明的总页数为准，而不是"这页不满 30 就停"
      if (declaredPages && pgNo >= declaredPages) break;
      if (!declaredPages && fresh.length === 0) break;
      if (!declaredPages && fresh.length < 30) break;
    }

    // 楼中楼：接口分页与楼层页一一对应
    const lzl = {};
    const totalPages = declaredPages || Math.ceil(floors.length / 30);
    for (let cpage = 1; cpage <= totalPages; cpage++) {
      await sleep(1200);
      try {
        const r = await fetch(
          `https://tieba.baidu.com/p/totalComment?tid=${tid}&fid=0&pn=${cpage}&see_lz=0`,
          { headers: { Cookie: this.#cookieHeader(), Referer: 'https://tieba.baidu.com/', 'User-Agent': MOBILE_UA } }
        );
        const j = await r.json();
        Object.assign(lzl, j?.data?.comment_list || {});
      } catch {}
    }

    const doc = {
      tid,
      pulledAt: new Date().toISOString(),
      pages: stopped ? 'partial' : 'complete',
      declaredPages: declaredPages || null,
      egress: firstEgress,
      floors,
      lzl,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(doc), { mode: 0o600 });
    return { ...doc, fromCache: false };
  }

  // ── 图片：下载 + 按像素面积压缩 ─────────────────────────────
  async #fetchImage(url, dest) {
    try {
      const r = await fetch(url, { headers: { Referer: 'https://tieba.baidu.com/', 'User-Agent': MOBILE_UA } });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch { return null; }
  }

  async #compressImage(file) {
    const maxArea = Number(this.cfg.imageMaxArea) || 0;
    if (!maxArea) return null;
    // 首次压缩后把原始尺寸写进 sidecar，重复运行时仍能报告"从多大压到多大"
    const sidecar = file.replace(/\.jpg$/, '.meta.json');
    if (fs.existsSync(sidecar)) {
      try { return JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {}
    }
    let w = 0, h = 0;
    try {
      const { stdout } = await pexec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
      const [a, b] = stdout.trim().split(',').map(Number);
      w = a; h = b;
    } catch { return null; }
    if (!w || !h) return null;
    const area = w * h;
    const capW = Number(this.cfg.imageMaxWidth) || 0;
    const capH = Number(this.cfg.imageMaxHeight) || 0;
    let scale = 1;
    if (area > maxArea) scale = Math.min(scale, Math.sqrt(maxArea / area));
    if (capW && w * scale > capW) scale = Math.min(scale, capW / w);
    if (capH && h * scale > capH) scale = Math.min(scale, capH / h);
    if (scale >= 0.999) {
      const meta = { width: w, height: h, compressed: false };
      fs.writeFileSync(sidecar, JSON.stringify(meta));
      return meta;
    }
    const nw = Math.max(16, Math.round(w * scale));
    const tmp = file.replace(/\.jpg$/, '.tmp.jpg');
    try {
      await pexec('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${nw}:-2`, '-q:v', '5', '-y', tmp]);
      fs.renameSync(tmp, file);
      const { stdout } = await pexec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
      const [nw2, nh2] = stdout.trim().split(',').map(Number);
      const meta = { width: nw2, height: nh2, originalWidth: w, originalHeight: h, compressed: true };
      fs.writeFileSync(sidecar, JSON.stringify(meta));
      return meta;
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      return { width: w, height: h, compressed: false };
    }
  }

  // ── 抽样 ────────────────────────────────────────────────────
  static dynamicCount(total, min, max) {
    if (total <= min) return total;
    let n;
    if (total <= 300) n = min + (total - min) * 0.3;
    else if (total <= 1000) n = 125 + (total - 300) * 0.15;
    else n = max;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  plan(total, overrides = {}) {
    const c = { ...this.cfg, ...overrides };
    const min = Number(c.sampleMin) || 50;
    const max = Number(c.sampleMax) || 120;
    const mode = c.sampleMode || 'dynamic';
    let want, policy;
    if (mode === 'all') { want = total; policy = { mode: 'all' }; }
    else if (mode === 'fixed') { want = Number(c.sampleFixed) || min; policy = { mode: 'fixed', count: want }; }
    else if (mode === 'ratio') { want = Math.round(total * (Number(c.sampleRatio) || 0.1)); policy = { mode: 'ratio', ratio: c.sampleRatio }; }
    else { want = Tieba.dynamicCount(total, min, max); policy = { mode: 'dynamic', min, max }; }
    want = Math.max(1, Math.min(total, want));
    policy.target = want;
    policy.ratio = total ? Number((want / total).toFixed(3)) : 1;
    return { want, policy };
  }

  // ── 读帖：抽样 + 取图 + 结构化 ──────────────────────────────
  async read(tid, opts = {}) {
    const doc = await this.pull(tid, opts);
    const floors = doc.floors;
    const total = floors.length;
    const lzFloor = floors.find((f) => f.isLz && f.author);
    const lz = lzFloor?.author || floors[0]?.author || null;

    const { want, policy } = this.plan(total, opts);
    const picked = new Set();
    if (want >= total) floors.forEach((_, i) => picked.add(i));
    else if (want === 1) picked.add(0);
    else for (let k = 0; k < want; k++) picked.add(Math.round((k * (total - 1)) / (want - 1)));
    floors.forEach((f, i) => { if (i === 0 || f.isLz || (lz && f.author === lz)) picked.add(i); });
    const idxs = [...picked].sort((a, b) => a - b);

    const imgDir = path.join(this.cfg.imageDir, String(tid));
    fs.mkdirSync(imgDir, { recursive: true });
    const imgMeta = {};
    const maxChars = Number(this.cfg.maxTextChars) || 0;
    // thumb（默认）| original | both —— 原图要额外下载，所以按需
    const quality = String(this.cfg.imageQuality || 'thumb').toLowerCase();
    const wantBoth = quality === 'both';
    const wantOriginal = quality === 'original' || wantBoth;
    // 原图只能从桌面页拿（移动页那个 ?src= 是没签名的占位图）。
    // 两份页面的图片文件名一致，用文件名把签名 URL 对回缩略图。
    const baseNameOf = (u) => {
      try { return decodeURIComponent(String(u).split('?')[0].split('/').pop()); } catch { return null; }
    };
    const wanted = [];
    if (wantOriginal) {
      for (const i of idxs) {
        const f = floors[i];
        for (let k = 0; k < f.images.length; k++) {
          const u = typeof f.images[k] === 'string' ? f.images[k] : f.images[k].thumb;
          const n = baseNameOf(u);
          if (n) wanted.push({ name: n, dest: path.join(imgDir, `f${i + 1}_${k + 1}_full.jpg`) });
        }
      }
    }
    const origGot = wantOriginal ? await this.#fetchOriginals(tid, wanted).catch(() => new Map()) : new Map();

    const out = [];
    for (const i of idxs) {
      const f = floors[i];
      const images = [];
      for (let k = 0; k < f.images.length; k++) {
        const img = f.images[k];
        const thumbUrl = typeof img === 'string' ? img : img.thumb;
        const baseName = baseNameOf(thumbUrl);
        const origUrl = (baseName && origGot.get(baseName)) || null;

        const fp = path.join(imgDir, `f${i + 1}_${k + 1}.jpg`);
        if (!fs.existsSync(fp)) {
          await this.#fetchImage(thumbUrl, fp);
          await sleep(400);
        }
        if (!fs.existsSync(fp)) continue;
        const meta = await this.#compressImage(fp);

        // 原图按需下载：默认只给缩略图，AI 需要看细节时再要
        let full = null;
        if (wantOriginal && origUrl) {
          const fpFull = path.join(imgDir, `f${i + 1}_${k + 1}_full.jpg`);
          if (!fs.existsSync(fpFull)) {
            await this.#fetchImage(origUrl, fpFull);
            await sleep(400);
          }
          if (fs.existsSync(fpFull)) {
            const m2 = await this.#compressImage(fpFull);
            full = { file: path.basename(fpFull), path: displayPath(fpFull), ...(m2 || {}) };
          }
        }

        images.push({
          // 原图外链（桌面页的签名地址）；拿不到就退回缩略图地址
          url: origUrl || thumbUrl,
          thumb: { file: path.basename(fp), path: displayPath(fp), ...(meta || {}) },
          ...(full ? { original: full } : {}),
        });
      }

      const rawText = cleanText(f.text);
      const truncated = maxChars > 0 && rawText.length > maxChars;
      const text = truncated ? rawText.slice(0, maxChars) : rawText;

      const c = doc.lzl?.[f.pid];
      const apiReplies = (c?.comment_info || []).map((x) => ({
        author: x.username || null, text: String(x.content || '').replace(/\s+/g, ' '),
      }));
      // 页内楼中楼文本自带 "名字: 内容" 前缀，拆开避免重复显示
      const domReplies = (f.subs || []).map((t) => {
        const m = /^([^:：\n]{1,24})[:：]\s*([\s\S]*)$/.exec(t);
        return m ? { author: m[1].trim(), text: m[2].trim() } : { author: null, text: t };
      });
      const replies = (apiReplies.length ? apiReplies : domReplies).slice(0, 10);

      out.push({
        // 页面给了 floor_num 就用它，锚点比下标可靠（删楼/抽楼时不会错位）
        index: f.floorNum || i + 1,
        percent: total > 1 ? Math.round((i / (total - 1)) * 100) : 100,
        author: f.author || null,
        isAuthor: i === 0 || !!f.isLz || !!(lz && f.author === lz),
        text,
        truncated,
        textLength: rawText.length,
        emojis: [...text.matchAll(/\[表情:([^\]]+)\]/g)].map((m) => m[1]),
        images,
        replies,
        replyCount: c?.comment_num ?? (f.subs || []).length,
      });
    }

    return {
      tid: String(tid),
      title: out[0]?.text?.split('\n')[0]?.slice(0, 120) || null,
      author: lz,
      // 只给楼主那层的时间：全贴唯一的时间参考，不逐层重复
      postedAt: formatPostedAt(floors[0]?.time),
      source: doc.pages,
      declaredPages: doc.declaredPages,
      pulledAt: doc.pulledAt,
      fromCache: !!doc.fromCache,
      totalFloors: total,
      sampledFloors: idxs.length,
      samplePolicy: policy,
      imageMaxArea: this.cfg.imageMaxArea,
      floors: out,
    };
  }
}

// ── 页内抽取（在浏览器上下文里执行）───────────────────────────
/**
 * 吧内帖子列表的抽取。选择器全部由调用方传入，改版时改配置即可，不必发版。
 * 每个字段独立容错：拿不到就是 null，不整条丢弃。
 */
export function BAR_IN_PAGE(sel) {
  const q = (root, s) => { try { return s ? root.querySelector(s) : null; } catch { return null; } };
  const txt = (e) => (e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const out = [];
  const seen = new Set();

  // 置顶：一个容器里塞了多条，每条就是一个 <a>，没有作者/回复数
  if (sel.barTopRow) {
    for (const box of document.querySelectorAll(sel.barTopRow)) {
      for (const a of box.querySelectorAll(sel.barTopLink || 'a[href*="/p/"]')) {
        const tid = (/\/p\/(\d+)/.exec(a.getAttribute('href') || '') || [])[1];
        if (!tid || seen.has(tid)) continue;
        seen.add(tid);
        out.push({
          tid,
          // 卡片里标题和摘要是两个 div：只取 .thread-title，别把摘要吞进来
          title: (txt(a.querySelector('.thread-title')) || txt(a))
            .replace(/^(置顶|精华|热门)\s*/, '').trim().slice(0, 140) || null,
          author: null,
          replies: null,
          lastReplyAt: null,
          isTop: true,
        });
      }
    }
  }

  for (const row of document.querySelectorAll(sel.barRow)) {
    const a = q(row, sel.barTitleLink);
    const tid = (/\/p\/(\d+)/.exec(a?.getAttribute('href') || '') || [])[1];
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);
    const title = (txt(q(row, sel.barTitle)) || txt(a)).slice(0, 140);
    const author = txt(q(row, sel.barAuthor)) || null;
    const body = (row.innerText || '').replace(/\s+/g, ' ');
    const lastReplyAt = ((/(回复于\s*[^\s|]+)/.exec(body) || [])[1] || '').replace(/^回复于\s*/, '') || null;
    const nums = [...body.matchAll(/(?:^|\s)(\d{1,5})(?=\s|$)/g)].map((m) => Number(m[1]));
    out.push({
      tid,
      title: title || null,
      author,
      replies: nums.length ? nums[0] : null,
      lastReplyAt,
      isTop: /置顶/.test(body) || undefined,
    });
    if (out.length >= 60) break;
  }
  return out;
}

export function GRAB_IN_PAGE() {
  // 贴吧显示的是 "10-22 12:22" / "2023-05-01 12:00" / "3小时前" 这类相对或简写时间
  const TIME_RE = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})(\s+\d{1,2}:\d{2})?$|^\d+\s*(分钟|小时|天)前$|^昨天(\s*\d{1,2}:\d{2})?$|^刚刚$/;
  const findTime = (item, content) => {
    // 优先带 time/date 语义的元素
    for (const e of item.querySelectorAll('[class*="time"],[class*="date"],[class*="floor_time"]')) {
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 24 && TIME_RE.test(t)) return t;
    }
    // 退回到叶子节点扫描，跳过正文区域（正文里常有日期）
    for (const e of item.querySelectorAll('*')) {
      if (content && (e === content || content.contains(e))) continue;
      if (e.children.length) continue;
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 24 && TIME_RE.test(t)) return t;
    }
    return '';
  };
  const walk = (node, acc) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { acc.text += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'img') {
        const src = n.getAttribute('data-original') || n.src || '';
        const cls = n.className || '';
        if (cls.includes('user_img') || cls.includes('nicknameEmoji')) continue;
        const em = src.match(/image_emoticon(\d+)/);
        const sb = src.match(/shoubai_emoji_face_(\d+)/);
        if (em) { acc.text += `[表情${em[1]}]`; continue; }
        if (sb) { acc.text += `[表情sb${sb[1]}]`; continue; }
        if (/tiebapic\.baidu\.com|imgsrc\.baidu\.com/.test(src)) {
          // 缩略图 URL 的 ?src= 参数里放的就是原图地址（实测可取到大图）
          let original = null;
          try {
            const p = new URL(src, location.href).searchParams.get('src');
            if (p && /^https?:\/\//.test(p)) original = p;
          } catch {}
          acc.images.push({ thumb: src, original });
          acc.text += `[图${acc.images.length}]`;
        }
        continue;
      }
      if (tag === 'br') { acc.text += '\n'; continue; }
      walk(n, acc);
      if (['p', 'div', 'li'].includes(tag)) acc.text += '\n';
    }
  };
  const out = [];
  for (const it of document.querySelectorAll('.post_list_item, .j_post_list_item')) {
    const pid = it.getAttribute('data-tid') || it.getAttribute('tid') || '';
    let author = '';
    let floorNum = 0;
    try {
      const info = JSON.parse(it.getAttribute('data-info') || '{}');
      author = info.un || info.user_name || info.author || '';
      floorNum = Number(info.floor_num) || 0;
    } catch {}
    if (!author) {
      const el = it.querySelector('.user_name, [class*="user_name"], .p_author, [class*="author"]');
      if (el) author = (el.innerText || '').replace(/\s+/g, ' ').trim().split('\n')[0];
    }
    const acc = { text: '', images: [] };
    const content = it.querySelector('.pb-rich-text, .d_post_content, .content, .abstract_content') || it;
    walk(content, acc);
    const t = acc.text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    const subs = [...it.querySelectorAll('.list_item_floor')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!t && !acc.images.length) continue;
    const isLz = !!it.querySelector('.floor_lz_icon, .j_floor_lz, [class*="lz_icon"], .lz_icon');
    out.push({ pid, author, text: t, images: acc.images, subs, isLz, floorNum, time: findTime(it, content) });
  }
  return out;
}

let EMOJI = null;
export function emojiTable(dir) {
  if (EMOJI) return EMOJI;
  try { EMOJI = JSON.parse(fs.readFileSync(path.join(dir, 'emoticon-names.json'), 'utf8')); }
  catch { EMOJI = {}; }
  return EMOJI;
}

export function cleanText(t, table = null) {
  const map = table || EMOJI || {};
  return String(t || '')
    .replace(/\[表情(\d+)\]/g, (m, n) => `[表情:${map[n] || n}]`)
    .replace(/\[表情sb(\d+)\]/g, '[表情:收白$1]')
    .replace(/看高清大图，打开贴吧App/g, '')
    .trim();
}
