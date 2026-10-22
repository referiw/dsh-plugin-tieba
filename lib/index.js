/**
 * dsh-plugin-tieba —— 只读百度贴吧的 DSH 插件。
 *
 * 注册三个工具：tieba_status / tieba_thread / tieba_bars。
 * 内核复用 lib/core.mjs（与 CLI 同一份实现）。
 */
import { Tieba, emojiTable } from './core.mjs';
import { readConfig } from './config-store.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
emojiTable(HERE);

export const name = 'tieba';
export const inject = ['tools', 'webServer'];

async function applyInner(ctx, config) {

  const mergeCfg = () => {
    const store = readConfig();
    const fromPatch = Object.fromEntries(Object.entries(config || {}).filter(([, v]) => v !== undefined));
    return { ...store, ...fromPatch };
  };
  const cfg = mergeCfg();
  // patch 里的 config 只在装配时读一次；之后以配置存储为准（设置页改完即时生效）
  const liveCfg = () => {
    const store = readConfig();
    const fromPatch = Object.fromEntries(Object.entries(config || {}).filter(([, v]) => v !== undefined));
    return { ...store, ...fromPatch };
  };
  const syncCfg = () => {
    const c = liveCfg();
    Object.assign(tb.cfg, {
      cookieFile: c.cookieFile,
      gapMs: c.gapMs,
      sampleMode: c.sampleMode,
      sampleMin: c.sampleMin,
      sampleMax: c.sampleMax,
      sampleFixed: c.sampleFixed,
      sampleRatio: c.sampleRatio,
      maxTextChars: c.truncateText ? c.maxTextChars : 0,
      imageMaxArea: c.imageMaxArea,
      imageMaxWidth: c.imageMaxWidth,
      imageMaxHeight: c.imageMaxHeight,
      cacheTtlMs: c.cacheTtlMs,
      maxPages: c.maxPages,
    });
    return c;
  };
  const tb = new Tieba({
    cookieFile: cfg.cookieFile,
    profileDir: cfg.profileDir,
    gapMs: cfg.gapMs,
    sampleMode: cfg.sampleMode,
    sampleMin: cfg.sampleMin,
    sampleMax: cfg.sampleMax,
    sampleFixed: cfg.sampleFixed,
    sampleRatio: cfg.sampleRatio,
    maxTextChars: cfg.truncateText ? cfg.maxTextChars : 0,
    imageMaxArea: cfg.imageMaxArea,
    imageMaxWidth: cfg.imageMaxWidth,
    imageMaxHeight: cfg.imageMaxHeight,
    cacheTtlMs: cfg.cacheTtlMs,
    maxPages: cfg.maxPages,
  });

  // 设置页接口
  try {
    import('./server.mjs').then((m) => {
      // 沿用 DSH 自己的 --trusted-host：网关/反代用户通常已经为 DSH 配过一遍，
      // 插件读过来就能用，不必再设 DSH_TIEBA_TRUSTED_HOST。
      const adopt = (svc) => { try { if (svc && Array.isArray(svc.trustedHosts)) m.inheritTrustedHosts(svc.trustedHosts); } catch {} };
      try { adopt(ctx.get?.('webStartup')); } catch {}
      try { ctx.inject?.(['webStartup'], (c) => adopt(c.get?.('webStartup') ?? c.webStartup)); } catch {}

      const offs = m.installRoutes(ctx.webServer);
      if (typeof ctx.on === 'function') ctx.on('dispose', () => offs.forEach((f) => { try { f && f(); } catch {} }));
    }).catch(() => {});
  } catch {}

  // 插件卸载时释放浏览器
  if (typeof ctx.on === 'function') ctx.on('dispose', () => { tb.close().catch(() => {}); });

  ctx.tools.register(defineTool({
    name: 'tieba_status',
    description: '查看贴吧登录状态。返回 loggedIn、失效原因与恢复提示。cookie 失效时先调用它确认，再让用户重新扫码。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: v.loggedIn
          ? `贴吧登录态正常${v.user ? `（${v.user}）` : ''}`
          : `贴吧未登录：${v.reason}${v.hint ? ` — ${v.hint}` : ''}`,
      }],
    },
    async execute() {
      syncCfg();
      return await tb.status();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'tieba_thread',
    description:
      '读取一个贴吧主题帖：先拉全文（带分页校验与缓存），再按策略抽样，返回按楼层顺序的结构化结果——' +
      '每层含正文、表情名、图片文件路径、楼中楼回复。图片默认按像素面积压缩。' +
      '图片给的是绝对路径（形如 …/.dsh-tieba/images/<tid>/f1_1.jpg），可以直接交给读图工具打开；' +
      '路径里会带你的用户名，贴到公开场合前留意打码。' +
      '典型用法：拿到 tid 后直接调用，先看正文；需要细看某层图片时再用 read_image 打开返回的路径。',
    parameters: {
      tid: { type: 'string', required: true, description: '帖子 id，例如 11124659583（来自帖子 URL /p/<tid>）' },
      refresh: { type: 'boolean', description: '忽略缓存重新抓取，默认 false' },
      sampleMode: { type: 'string', enum: ['dynamic', 'fixed', 'ratio', 'all'], description: '覆盖默认抽样方式' },
      floors: { type: 'number', description: 'sampleMode=fixed 时的层数' },
      ratio: { type: 'number', description: 'sampleMode=ratio 时的比例（0~1）' },
      truncateText: { type: 'boolean', description: '覆盖默认的截断开关' },
      maxTextChars: { type: 'number', description: '截断时每层保留字数' },
      imageMaxArea: { type: 'number', description: '覆盖图片像素面积上限' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const lines = [
          `《${v.title || '无标题'}》 楼主 ${v.author || '匿名'} ｜ 全文 ${v.totalFloors} 层 ｜ 抽取 ${v.sampledFloors} 层`,
          '',
        ];
        for (const f of v.floors) {
          lines.push(`【第 ${f.index} 层 ${f.percent}% ${f.author || '匿名'}${f.isAuthor ? ' 楼主' : ''}】`);
          lines.push(f.text + (f.truncated ? ` …(截断, 原长 ${f.textLength})` : ''));
          for (const im of f.images) lines.push(`[图 ${im.path}${im.compressed ? ` ${im.originalWidth}x${im.originalHeight}→${im.width}x${im.height}` : ''}]`);
          if (f.replies.length) {
            lines.push(`└ 楼中楼 ${f.replyCount || f.replies.length} 条:`);
            for (const r of f.replies.slice(0, 5)) lines.push(`  · ${r.author || '?'}: ${r.text.slice(0, 120)}`);
          }
          lines.push('');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const overrides = {};
      if (args.sampleMode) overrides.sampleMode = args.sampleMode;
      if (args.floors) { overrides.sampleMode = 'fixed'; overrides.sampleFixed = args.floors; }
      if (args.ratio) { overrides.sampleMode = 'ratio'; overrides.sampleRatio = args.ratio; }
      if (args.truncateText !== undefined) {
        overrides.maxTextChars = args.truncateText ? (args.maxTextChars ?? cfg.maxTextChars) : 0;
      } else {
        overrides.maxTextChars = cfg.truncateText ? cfg.maxTextChars : 0;
      }
      if (args.imageMaxArea) overrides.imageMaxArea = args.imageMaxArea;

      // 抽样参数在 plan() 里读，图片/截断在 read() 里读，所以两处都要传
      const c = syncCfg();
      Object.assign(tb.cfg, overrides);
      return await tb.read(args.tid, { refresh: !!args.refresh, maxPages: c.maxPages });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'tieba_bars',
    description: '列出当前账号关注的贴吧。用于确认登录有效、或发现有哪些吧可以读。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `关注的吧（${v.count}）：${v.bars.join('、')}` }],
    },
    async execute() {
      syncCfg();
      const st = await tb.status();
      if (!st.loggedIn) return { count: 0, bars: [], error: st.reason };
      const bars = await tb.bars();
      return { count: bars.length, bars };
    },
  }));
}


// 兜底：插件自身的任何异常都不允许冒泡回宿主，否则一个插件能把整棵树拖下水。
export async function apply(ctx, config) {
  try {
    await applyInner(ctx, config);
  } catch (err) {
    try {
      console.error('[dsh-plugin-tieba] 装配失败（已隔离，不影响其它插件）：', err && err.message);
    } catch {}
  }
}
