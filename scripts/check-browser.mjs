#!/usr/bin/env node
/**
 * 打印本机会用哪个浏览器，用于排查"扫码打不开 / 抓取报错"。
 *
 * 这个插件不再自带 Chromium：它驱动系统里已有的 Chrome / Edge / Chromium。
 * 所以这个脚本回答的问题是"我这台机器上，插件会挑中哪一个"。
 */
import { describeBrowser } from '../lib/browser.mjs';

const r = await describeBrowser();
if (r.ok) {
  console.log(`可用：${r.kind}（${r.version}）`);
  process.exit(0);
}
console.error(r.error);
process.exit(1);
