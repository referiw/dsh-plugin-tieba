import path from 'node:path';
import { chromium } from 'playwright';
import { PROFILE_DIR, HOME_DIR } from '../lib/paths.mjs';
import fs from 'node:fs';

// 用法：node dump-cookies.mjs <domain> <out.json> [先访问的URL]
const domain = process.argv[2] || 'baidu.com';
const out = process.argv[3] || path.join(HOME_DIR, 'dump.cookies.json');
const warm = process.argv[4] || '';

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  timezoneId: 'Asia/Shanghai',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

if (warm) {
  // 先访问目标站，让它把该域下的会话 cookie（STOKEN/PTOKEN 等）下发
  await page.goto(warm, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
}

const cookies = await ctx.cookies(`https://${domain}`).catch(() => []);
fs.writeFileSync(out, JSON.stringify(cookies, null, 2), { mode: 0o600 });
console.log(`dumped ${cookies.length} cookies for ${domain} → ${out}`);
console.log('names:', cookies.map((c) => c.name).join(', ').slice(0, 240));

// 顺便自检一次
const probe = await page
  .evaluate(async () => {
    try {
      const r = await fetch('https://tieba.baidu.com/dc/common/tbs', { credentials: 'include' });
      return await r.text();
    } catch (e) {
      return 'ERR ' + e.message;
    }
  })
  .catch((e) => 'ERR ' + e.message);
console.log('tbs probe:', probe.slice(0, 120));

await ctx.close();
