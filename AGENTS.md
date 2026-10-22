# AGENTS.md

给接手这个仓库的 agent 看的工程说明。人类读者请看 [README.md](./README.md)。

---

## 一句话

把百度贴吧的一栋楼读成结构化材料，交给 agent。**只读**，不写任何东西回贴吧。

## 不可违反的约束

改代码前先读完这几条，它们都是撞出来的，不是理论：

**1. 翻页必须"一页一会话"。**
同一个 browser context 里连续请求 `pn=0 → 30 → 60` 会被判成翻页机器人，弹
`wappass.baidu.com/.../captcha/tuxing.html`。**加大间隔、换出口 IP 都救不回来**，只有每页
`newContext()` + `addCookies()` 才行。见 `lib/core.mjs` 的 `#fetchFloorPage`。

**2. 移动版的 `pn` 是楼层偏移，不是页码。**
`pn=0` → 1–30 层，`pn=30` → 31–60 层。写成 `pn=2` 返回空页。吧列表同理，只是步长是 50。

**3. 不要用裸 cookie 判定登录。**
`dc/common/tbs` 会 301 跳到 `http://`，而 `BDUSS` 是 `Secure` cookie，永远返回 `is_login:0`。
判定只能靠**打开桌面版首页读 DOM**（"我关注的吧"侧栏），或同源 fetch
`/f/user/json_userinfo`（顺带给出 `user_name_url` / `user_name_show` / `user_portrait`）。

**4. 桌面版是前端渲染，抓不到楼层。**
必须走移动版 `/mo/q/m`。`TIEBA_NEW_PC=0` 也切不回旧版 PC 皮肤。

## DSH 插件契约（错一条整棵树起不来）

**服务端（`lib/index.js`）禁止 static `import '@deepseek-ai/*'`。**
以 `link:` 安装时 Node 按 realpath 解析，会绕过 profile 的 `node_modules`，模块加载阶段就抛
`ERR_MODULE_NOT_FOUND`。必须懒加载 + 恒等兜底：

```js
let defineTool = (d) => d;
try {
  const m = await import('@deepseek-ai/dsh-tools');
  if (typeof m?.defineTool === 'function') defineTool = m.defineTool;
} catch { /* 宿主没暴露 */ }
```

**客户端（`lib/client.js`）是 `window.__ModuleLoader__.load({id, factory})` 的经典脚本。**
不是 ESM（`export` 会语法错），也不是 CJS（没有裸 `exports`）。`id` 必须等于包名，
React 必须 `require('react')`（dsh web 没有全局 React）。现成样例：
`node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`。

**`apply` 必须整体包 try/catch。** 一个插件抛异常不该拖垮整个 profile。

**装完必须进 `dsh.profile.bundles`**，否则设置页永远显示关闭。

## 代码地图

| 文件 | 职责 | 改它要注意 |
|---|---|---|
| `lib/core.mjs` | 内核：登录态、翻页、抽样、图片压缩 | 唯一实现，CLI 和插件共用，别复制 |
| `lib/index.js` | DSH 插件入口，注册 3 个工具 | 不能有 static 宿主 import |
| `lib/server.mjs` | 设置页 HTTP 接口 | 每个路由都要过 `isLocalRequest` |
| `lib/client.js` | 设置页 UI | 必须是 `__ModuleLoader__` 外壳 |
| `lib/config-store.mjs` | 配置读写（JSON + mtime 缓存） | 工具调用时重读，改完即时生效 |
| `lib/paths.mjs` | 所有运行期路径 | 只在这里拼路径 |
| `displayPath()`（core） | 对外展示路径 | 输出一律相对家目录，**不要写绝对路径**（会泄露用户名） |
| `src/cli.mjs` | 命令行 | 薄封装，不写业务逻辑 |
| `src/login.mjs` | 扫码登录 | 登录判定必须同源发起（CORS） |

数据流：

```
tid ──> pull() ──> cache/<tid>.json  (floors + lzl)
          │
          ├─ plan()   动态抽样 + 楼主楼层补齐
          ├─ images/  只下被选中楼层的图，按像素面积压缩
          └─ read()   按楼层顺序组装结构化结果
```

## 运行期数据

全部在 `~/.dsh-tieba/`（`DSH_TIEBA_HOME` 可覆盖），不进版本库：

```
~/.dsh-tieba/
├── cookies.json   # 登录态，0600
├── config.json    # 设置页写的配置
├── cache/<tid>.json
├── images/<tid>/f<楼层>_<序号>.jpg (+ .meta.json)
└── profile/       # 仅 login.mjs 用的持久化 profile
```

## 怎么验证改动

不要只看代码，跑真实请求：

```bash
node src/cli.mjs status                       # 登录态：应含 user / nickname / avatar
node src/cli.mjs thread <tid> --json          # 结构化：检查 sampledFloors、images、replies
node src/cli.mjs thread <tid> --no-sample     # 全量
ffprobe -v error -show_entries stream=width,height -of csv=p=0 <图片>   # 验证压缩
```

安全守卫可以离线单测（导出在 `lib/server.mjs`）：

```js
import { isLocalRequest } from './lib/server.mjs';
isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} });                       // true
isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1' } }); // false
```

## 加一个工具

1. 在 `lib/index.js` 的 `apply` 里 `ctx.tools.register(defineTool({...}))`
2. 参数用 `parameters: { 名字: { type, description } }`
3. `output.render` 只返回 `{ type: 'text', text }` —— **不要返回图片二进制**，
   图片给路径，由 agent 自己 `read_image`
4. 执行前调 `syncCfg()`，让设置页的改动即时生效

## 常见故障

| 症状 | 原因 |
|---|---|
| 整个 DSH 起不来 | 大概率是 static 宿主 import 或客户端格式错，见上文契约 |
| `tieba_status` 报 `no_cookie` | `cookies.json` 不存在或路径不对 |
| 报 `expired` | cookie 失效，重扫码 |
| 抓到的楼层数偏少 | 分页校验依赖页面 `1/N`，若被风控可能拿到局部 |
| 图片是空白/0 字节 | 图床需要 Referer，`#fetchImage` 已带 |
| 设置页头像不显示 | `himg.bdimg.com` 被本地网络拦截 |
