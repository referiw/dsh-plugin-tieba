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

**工具用官方 `defineTool`，静态引入，别自己拼 schema。**

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

ctx.tools.register(defineTool({
  name, description,
  parameters: { tid: { type: 'string', required: true, description: '…' } },
  output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [...] },
  async execute(args) { … },
}));
```

`defineTool` 负责把 `{ 参数名: { type, required, description } }` 编译成 JSON Schema、校验入参、
收口 output。**不要手写 JSON Schema，也不要自己实现编译兜底**——曾经这么干过（0.2.0/0.2.1），
理由是不信任宿主投影，结果把一个 20 行的注册写成了 80 行，还被 API 拒过。

**依赖必须放 `dependencies`，不能只放 `peerDependencies`。** 这一条容易被 review 挑，所以写清楚：

- 官方包（如 `@deepseek-ai/dsh-tool-todo`）是静态 import，靠宿主把安装包投影到
  `$DSH_HOME/profiles/node_modules` 来解析——那是**第一方**包的特权；
- 第三方插件没有这个投影保障：桌面版的包在 `app.asar` 里，junction 指不进 asar；
  实测某台机器 `profiles/node_modules` 187 项里 164 项是悬空 junction；
- 而 pnpm 默认不装 peer（本仓库 `.npmrc` 也是 `auto-install-peers=false`），只声明 peer
  等于运行期 `ERR_MODULE_NOT_FOUND`。

所以这里把 `@deepseek-ai/dsh-tools` 声明成普通依赖，版本**跟宿主 DSH 对齐**
（当前 `0.2.1-rc.2`）。代价是多一份约 150 KB 的副本，换的是 link: 装、npm 装、任何机器都一致。
升级 DSH 时记得同步这个版本号。

> 注意它 npm 上的 `latest` 是 `0.0.1-rc.1`，`0.2.1-rc.2` 在 `next` tag 下——安装时要写精确版本。

**工具 schema 是启动时注册的。** 换包/升级插件后必须重启 DSH，否则进程里还是旧注册——
旧版本有问题时会表现为"升级了但还是报同一个错"。

**客户端（`lib/client.js`）是 `window.__ModuleLoader__.load({id, factory})` 的经典脚本。**
不是 ESM（`export` 会语法错），也不是 CJS（没有裸 `exports`）。`id` 必须等于包名，
React 必须 `require('react')`（dsh web 没有全局 React）。现成样例：
`node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`。

**`apply` 必须整体包 try/catch。** 一个插件抛异常不该拖垮整个 profile。

**包名必须在 `dsh.profile.bundles` 里**，否则 entry 不会被合成——设置页没入口、工具不注册。
`dsh plugin --profile <profile> add <pkg>` **会自动写**这一项（实测：装完 bundles 末尾就多了包名），
所以标准安装路径不用手改。只有 `pnpm add link:` 这种直接调 pnpm 的做法才需要手工补。

## 代码地图

| 文件 | 职责 | 改它要注意 |
|---|---|---|
| `lib/core.mjs` | 内核：登录态、翻页、抽样、图片压缩 | 唯一实现，CLI 和插件共用，别复制 |
| `lib/index.js` | DSH 插件入口，注册 3 个工具 | 不能有 static 宿主 import |
| `lib/server.mjs` | 设置页 HTTP 接口 | 每个路由都要过 `isLocalRequest` |
| `lib/client.js` | 设置页 UI | 必须是 `__ModuleLoader__` 外壳 |
| `lib/config-store.mjs` | 配置读写（JSON + mtime 缓存） | 工具调用时重读，改完即时生效 |
| `lib/paths.mjs` | 所有运行期路径 | 只在这里拼路径 |
| `lib/browser.mjs` | 定位并启动浏览器 | 别退回"绑定 playwright 版本"的写法，见下文 |
| `scripts/check-browser.mjs` | 诊断：打印选中的浏览器 | 只读，不改状态，可随时跑 |
| `displayPath()`（core） | 对外展示路径 | 默认返回**绝对路径**（读图工具不展开 `~`，相对路径只在 cwd=家目录时成立）；`DSH_TIEBA_PATH_STYLE=home` 才切回 `~/...` |
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

## 浏览器（`lib/browser.mjs`）

**为什么躲不掉**：贴吧对未登录请求一律回「百度安全验证」页。实测纯 HTTP 全废——

| 客户端 | 结果 |
|---|---|
| Node `fetch` | 403 安全验证 |
| `curl`（带 cookie jar 走一次首页） | 403 |
| `curl_cffi` 模拟 Chrome / Safari / Edge 的 TLS 指纹 | 403 |
| 真浏览器 | 能进；未登录时要求过滑块，登录后正常 |

所以**不是 TLS 指纹问题，是会话问题**：换任何 HTTP 客户端都没用，除非带着已通过风控的 cookie。
`p/totalComment`（楼中楼）和图片下载之所以能用纯 `fetch`，是因为它们不在这层风控后面。

**不要绑定版本**：Playwright 按"版本 → 浏览器 revision"映射（1.64 → shell-1248），换个版本号，
已经下好的浏览器就作废了。这里改成**扫描磁盘 + 用路径启动**，任何 revision 都能用。
实测 `playwright-core@1.64` 能驱动 `chromium_headless_shell-1223`（Chrome 148）。

解析顺序（第一个能起来就记住，失败清缓存重探）：

```
DSH_TIEBA_CHROME → ms-playwright 里的 headless shell / chromium（新版本优先） → 系统 Chrome → Edge → Chromium
```

排查：`node scripts/check-browser.mjs`。

## 打包与发布

- `files` 必须覆盖 `lib/ src/ scripts/ locale/ icon.svg cordis.patch.yml docs/`——少一个，
  用户装到的就是残包（`bin` 指向 `src/cli.mjs`，尤其别漏）。
- 全局 registry 可能是国内镜像（只读），`publishConfig.registry` 已钉 `https://registry.npmjs.org`。
- **发完先看 `dist-tags`**：新版 npm 有 staged publishing，包不存在时会先公开一个
  `0.0.0-stage` 占位版本（`stub: true`，几百字节），真正的版本要 `npm stage approve <id>` 才公开。
  看到 `0.0.0-stage` 不代表发布失败，也不代表成功。
- 验证发布结果别只看 `npm view`，直接装一遍：
  `npm i dsh-plugin-tieba@<ver> --registry=https://registry.npmjs.org`，然后 `import` 主入口。

## 常见故障

| 症状 | 原因 |
|---|---|
| 整个 DSH 起不来 | 大概率是 static 宿主 import 或客户端格式错，见上文契约 |
| 设置页没有「贴吧」这一节 | 包没进 `dsh.profile.bundles`；`--dump-config \| grep tieba` 确认 |
| 扫码后界面一直"未登录" | 写 cookie 前没建 `~/.dsh-tieba/`（`poll()` 里已加 `ensureHome()`）；或轮询返回的 500 被前端吞了 |
| 二维码是破图 | 没有可用浏览器，或 `login/start` 失败；看 `/tieba/api/login/start` 的 JSON |
| `tieba_status` 报 `no_cookie` | `cookies.json` 不存在或路径不对 |
| 报 `expired` | cookie 失效，重扫码 |
| 抓到的楼层数偏少 | 分页校验依赖页面 `1/N`，若被风控可能拿到局部 |
| 图片是空白/0 字节 | 图床需要 Referer，`#fetchImage` 已带 |
| 图片路径是裸文件名 | `displayPath()` 的分隔符处理错了（Windows 上 `\` 和 `/` 不匹配） |
| 设置页头像不显示 | `himg.bdimg.com` 被本地网络拦截 |
