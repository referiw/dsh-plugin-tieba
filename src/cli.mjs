#!/usr/bin/env node
/**
 * 贴吧 CLI（只读）。内核在 lib/core.mjs，插件复用同一份。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tieba, emojiTable } from '../lib/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
emojiTable(path.join(HERE, '..', 'lib'));

const argv = process.argv.slice(2);
const cmd = argv[0];
const target = argv[1];
const has = (f) => argv.includes(`--${f}`);
const flag = (f, d) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : d; };

const USAGE = `用法:
  tieba status                       # 登录状态
  tieba thread <tid> [选项]           # 全文→抽样→带图输出
  tieba login                        # 扫码登录

thread 选项:
  --refresh          忽略缓存重拉
  --json             结构化输出（进度走 stderr）
  --no-sample        全读
  --floors N         固定层数
  --ratio R          固定比例
  --min N --max N    动态抽样上下界（默认 50/300）
  --max-chars N      正文截断字数（0=不截断）
  --max-area N       图片像素面积上限（默认 1200000）
  --gap MS           请求间隔（默认 4000）`;

if (!cmd || ['-h', '--help'].includes(cmd)) { console.log(USAGE); process.exit(0); }

const tb = new Tieba({
  ...(has('gap') ? { gapMs: Number(flag('gap')) } : {}),
  ...(has('max-chars') ? { maxTextChars: Number(flag('max-chars')) } : {}),
  ...(has('max-area') ? { imageMaxArea: Number(flag('max-area')) } : {}),
  ...(has('min') ? { sampleMin: Number(flag('min')) } : {}),
  ...(has('max') ? { sampleMax: Number(flag('max')) } : {}),
  ...(has('no-sample') ? { sampleMode: 'all' } : {}),
  ...(has('floors') ? { sampleMode: 'fixed', sampleFixed: Number(flag('floors')) } : {}),
  ...(has('ratio') ? { sampleMode: 'ratio', sampleRatio: Number(flag('ratio')) } : {}),
});

try {
  if (cmd === 'status') {
    const s = await tb.status();
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.loggedIn ? 0 : 3);
  }

  if (cmd === 'login') {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(HERE, 'login.mjs'), '--site', 'tieba'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }

  if (cmd === 'thread') {
    if (!target) { console.error('缺少 tid'); process.exit(2); }
    const t0 = Date.now();
    const res = await tb.read(target, { refresh: has('refresh'), maxPages: Number(flag('max-pages', 30)) });
    if (has('json')) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      const imgs = res.floors.reduce((a, f) => a + f.images.length, 0);
      console.log(`\n=== ${res.title || '(标题未取到)'} ===`);
      console.log(`楼主：${res.author || '匿名'} ｜ 全文 ${res.totalFloors} 层(${res.source}) ｜ 读 ${res.sampledFloors} 层（${res.samplePolicy.mode} ${res.samplePolicy.ratio}）｜ 图 ${imgs} 张 ｜ ${res.fromCache ? '缓存' : '新拉'} ${Date.now() - t0}ms\n`);
      for (const f of res.floors) {
        console.log(`\n──── 第 ${f.index} 层 ｜ ${f.percent}% ｜ ${f.author || '匿名'}${f.isAuthor ? ' 【楼主】' : ''}`);
        console.log(f.text + (f.truncated ? `\n   …（已截断，原长 ${f.textLength} 字）` : ''));
        for (const im of f.images) {
          const note = im.compressed ? `（${im.originalWidth}x${im.originalHeight} → ${im.width}x${im.height}）` : '';
          console.log(`   🖼  ${im.path} ${note}`);
        }
        if (f.replies.length) {
          console.log(`   └ 楼中楼 ${f.replyCount || f.replies.length} 条：`);
          for (const r of f.replies.slice(0, 5)) console.log('     · ' + (r.author ? r.author + ': ' : '') + r.text.slice(0, 160));
        }
      }
    }
    process.exit(0);
  }

  console.error(USAGE);
  process.exit(2);
} finally {
  await tb.close();
}
