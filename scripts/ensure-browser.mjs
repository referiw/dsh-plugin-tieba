#!/usr/bin/env node
/**
 * 尽力保证 Playwright 的 chromium 就绪。
 *
 * 浏览器的二进制不是 npm 包，装依赖时不会跟着下来；这里在 postinstall 里补一次。
 * 任何失败都只警告、退出码仍为 0——安装不应该因为下载失败而中断，
 * 真正需要浏览器的时候（扫码 / 抓取）会给出明确报错。
 *
 * 注意：以 `link:` 方式安装的包不会执行自身的 postinstall，那种情况请手动跑
 * `npx playwright install chromium` 或 `npm run setup`。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function cliPath() {
  // playwright 的 exports 不含 ./cli.js，只能先定位包根再拼
  const pkg = require.resolve('playwright/package.json');
  return path.join(path.dirname(pkg), 'cli.js');
}

try {
  const cli = cliPath();
  console.log('[dsh-plugin-tieba] 检查 Playwright 浏览器（已装则秒过，首次约 200 MB）…');
  execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  console.log('[dsh-plugin-tieba] 浏览器就绪。');
} catch (e) {
  console.warn('[dsh-plugin-tieba] 浏览器没有准备好：' + ((e && e.message) || e));
  console.warn('[dsh-plugin-tieba] 首次使用前请手动运行：npx playwright install chromium');
}

process.exit(0);
