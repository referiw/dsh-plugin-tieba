<p align="center">
  <img src="icon.svg" width="88" height="88" alt="dsh-plugin-tieba">
</p>

<h1 align="center">贴吧阅读器</h1>

<p align="center">
  <b>把百度贴吧的一整栋楼，读成一份带图的结构化材料。</b><br>
  <sub>DeepSeek Harness 插件 · 只读 · 不发言、不点赞、不签到、不关注</sub>
</p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-tieba"><img alt="npm" src="https://img.shields.io/npm/v/dsh-plugin-tieba.svg"></a>
  <img alt="dsh" src="https://img.shields.io/badge/dsh-%3E%3D0.2.0-blueviolet.svg">
</p>

<p align="center"><sub>非官方项目，由社区成员独立开发维护，与 DeepSeek 官方无关。</sub></p>

<p align="center">
  <img src="docs/settings.png" width="660" alt="设置页：登录状态、抽样策略、输出截断、图片压缩、请求节流">
</p>

<p align="center"><sub>登录状态、抽样方式、是否截断、图片压多大、请求多慢——设置页里改完即时生效。</sub></p>

<details>
<summary><b>目录</b></summary>

- [它能产出什么](#它能产出什么)
- [安装](#安装)
- [登录](#登录)
- [工具](#工具)
- [抽样策略](#抽样策略)
- [配置](#配置)
- [命令行](#命令行)
- [为什么必须用浏览器](#为什么必须用浏览器)
- [与 DSH 的集成方式](#与-dsh-的集成方式)
- [安全](#安全)
- [已知限制](#已知限制)
- [与其他插件共存](#与其他插件共存)
- [项目结构](#项目结构)
- [开发](#开发)
- [彩蛋](#彩蛋)
- [许可](#许可)

</details>

## 它能产出什么

给一个 `tid`，回一份按楼层顺序排好的材料：

```text
《示例帖子：一个关于融资的讨论》 楼主 用户甲 ｜ 发帖 2026-10-22 12:22 ｜ 全文 39 层 ｜ 抽取 39 层

【第 1 层 0% 用户甲 楼主】
示例帖子的主楼内容
 [图1]
[图 …/.dsh-tieba/images/1234567890/f1_1.jpg 250x304 ｜ http://tiebapic.baidu.com/…jpg]

【第 3 层 5% 用户乙】
这是某一层楼的回复内容[表情:咧嘴笑]
└ 楼中楼 2 条:
  · 用户丙: 这是楼中楼里的一条回复
```

| 特性 | 说明 |
|---|---|
| 按楼层 | 图片紧跟所属楼层，楼中楼挂在楼层下方；楼层号取页面给的 `floor_num` |
| 时间参考 | 顶部给楼主的发帖时间（全贴只此一处），相对时间会归一成 `YYYY-MM-DD HH:MM` |
| 表情转中文 | `image_emoticon22` → `[表情:咧嘴笑]`，**不读图** |
| 省上下文 | 头像、昵称挂件永久跳过 |
| 图片 | 每张图给三样：`thumb`（本地缩略图，默认读这个）、`original`（按需下载的原图）、`url`（原图外链） |
| 路径样式 | `DSH_TIEBA_PATH_STYLE`：默认绝对路径；`rel` 相对当前工作目录；`home` 输出 `~/...`（需调用方自行展开） |

## 安装

要求 **DSH ≥ 0.2.0**（已声明 `engines.dsh`，版本不匹配时整包被跳过而不是半加载）。

```bash
dsh plugin --profile <profile> add dsh-plugin-tieba
```

`<profile>` 换成你在用的那个：跑 `dsh web` 就是 `web`，`ls ~/.dsh/profiles` 能看到全部。

这条命令会同时写 `dependencies` 和 `dsh.profile.bundles`，**不用手工编辑**。装完重启 DSH，浏览器硬刷新一次。

> **桌面版注意**：`desktop` profile 由 Electron 独占管理，命令行会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。桌面用户请走 **设置 → 插件** 安装，或用 `--profile web` 起一个独立 profile。

> **升级插件后也要重启**（不只是第一次装）：工具 schema 是在启动时注册的，不重启会继续用旧的那份。旧版本有问题时，症状就是对话被 API 直接拒绝。

**浏览器**：插件要用真实浏览器渲染贴吧页面，但通常不用额外装——Windows / macOS 自带 Edge 或装了 Chrome 就够了。只有系统里找不到任何 chromium 系浏览器时（多见于干净的 Linux 服务器）：

```bash
npx playwright-core install chromium --only-shell   # 约 118 MB
# 或者：sudo apt install chromium
```

`npm run check-browser` 可以看实际会选中哪个浏览器。

<details>
<summary><b>从源码安装（改代码时用）</b></summary>

```bash
git clone https://github.com/referiw/dsh-plugin-tieba ~/dsh-plugin-tieba
cd ~/.dsh/profiles/<profile> && pnpm add link:~/dsh-plugin-tieba
```

这条路直接调 pnpm，**不会**改 bundles，需要手工把 `"dsh-plugin-tieba"` 追加到该 profile `package.json` 的 `dsh.profile.bundles` 数组末尾。

Windows 上保存成 **UTF-8 无 BOM**——带 BOM 时 DSH 读配置会抛 `Unexpected token '\uFEFF'`。

</details>

## 登录

贴吧的登录态只能靠真实浏览器拿到。

**设置页（推荐）**：DSH → 设置 → 贴吧 → 重新扫码登录。二维码直接显示在页面里，扫完自动变「已登录」。

**命令行**：`node src/login.mjs`

cookie 落在 `~/.dsh-tieba/cookies.json`（`0600`），可用 `DSH_TIEBA_HOME` 改目录。

## 工具

| 工具 | 作用 |
|---|---|
| `tieba_bar` | 列某个吧的帖子（最新 / 最热 / 精华），拿到 tid 再读正文 |
| `tieba_thread` | 读一个帖子：拉全文 → 抽样 → 按楼层顺序返回 |
| `tieba_status` | 登录态（贴吧 ID、昵称、头像） |
| `tieba_bars` | 当前账号关注的吧 |

```jsonc
// tieba_bar
{ "kw": "v", "tab": "最新", "page": 1 }   // tab: 最新 | 最热 | 精华
```

返回 `[{ tid, title, author, replies, lastReplyAt, isTop }]`，直接拿 `tid` 就能喂给 `tieba_thread`。置顶帖会排在最前、`isTop: true`，但它们没有作者和回复数（卡片上就没有这些字段）。

> 贴吧没有可用的公开列表接口（`/c/f/frs/page` 返回 `error_code 110001`），只能读渲染后的 DOM。
> 前端改版时列表会抽不出来——把 `config.selectors` 里的四个选择器改掉即可，**不用等发版**：
> `barRow` / `barTitleLink` / `barTitle` / `barAuthor`，默认值就是当前实测可用的那套。

```jsonc
// tieba_thread 的常用参数
{
  "tid": "1234567890",      // 必填，来自 URL /p/<tid>
  "refresh": false,          // 忽略缓存重拉
  "sampleMode": "dynamic",   // dynamic | fixed | ratio | all
  "floors": 100,             // sampleMode=fixed 时的层数
  "ratio": 0.1,              // sampleMode=ratio 时的比例
  "truncateText": true,      // 是否截断过长楼层（默认开）
  "maxTextChars": 600,       // 截断时每层保留字数
  "imageQuality": "thumb",   // thumb | original | both
  "imageMaxArea": 1200000    // 图片像素面积上限
}
```

图片默认只下缩略图（贴吧移动页给的就是 250px 宽），够看清版式；要读小字（聊天截图、票面、字幕）时传 `imageQuality: "original"` 或 `"both"`，会额外下载原图并给出 `original.path`。

原图不在移动页里：移动页那个 `?src=` 参数看着像原图地址，其实没有签名，取回来是 238×238 占位图。真正的原图要从**桌面页**拿（带签名的 `pic/item` 地址），两边文件名一致，于是用文件名对齐；下载也必须走浏览器上下文，Node 的 `fetch` 没有指纹，同样会拿到占位图。

代价是这一档要多开一次桌面页（约 +5 秒），而且**可能拿不全**——桌面页懒加载，个别图仍未签到时只给缩略图。`url` 字段是能拿到的最好的那张的地址（原图优先，否则缩略图），可以直接引用。

## 抽样策略

默认**动态抽样**：楼层越多比例越低，结果夹在 `[min, max]` 之间。

| 总楼层 | 抽多少 | 比例 |
| ---: | ---: | ---: |
| ≤ 50 | 全读 | 100% |
| 100 | 65 | 65% |
| 300 | 125 | 42% |
| 1000 | 230 | 23% |
| > 1000 | 300（封顶） | < 30% |

**楼主楼层始终补齐**，不占抽样名额。匿名帖没有用户名可匹配，第 1 层恒判为楼主。

## 配置

设置页可改，也可直接编辑 `~/.dsh-tieba/config.json`（即时生效，无需重启）。

| 键 | 默认 | 说明 |
|---|---|---|
| `sampleMode` | `dynamic` | 抽样方式 |
| `sampleMin` / `sampleMax` | `50` / `120` | 动态抽样的上下界 |
| `sampleFixed` / `sampleRatio` | `50` / `0.2` | fixed / ratio 模式的取值 |
| `truncateText` | `true` | 是否截断过长楼层（默认开，省上下文） |
| `maxTextChars` | `600` | 截断时保留的字数 |
| `imageQuality` | `thumb` | `thumb` 只下缩略图；`original` 下原图；`both` 都下 |
| `imageMaxArea` | `1200000` | 图片像素面积上限，超出等比缩小 |
| `imageMaxWidth` / `imageMaxHeight` | `1280` / `2000` | 图片尺寸上限 |
| `gapMs` | `4000` | 请求间隔（毫秒） |
| `selectors` | 见上文 | 列表页的四个选择器 + 两个置顶选择器；前端改版时改这里 |
| `cacheTtlMs` | `600000` | 全文缓存有效期 |
| `maxPages` | `30` | 单帖最多抓多少页 |

## 命令行

不想装插件也能直接用：

```bash
tieba status                    # 登录态
tieba thread 1234567890         # 读帖
tieba thread 1234567890 --json  # 结构化输出
```

`tieba` 是包的 `bin`；没全局安装时用 `node src/cli.mjs status` 等效。

## 为什么必须用浏览器

贴吧对**未登录**的请求一律回「百度安全验证」页，`fetch` / `curl` 连正文都拿不到——我试过模拟 Chrome / Safari / Edge 的 TLS 指纹（`curl_cffi`），全是 403。能拿到楼层内容的只有真实浏览器引擎。

另外三个坑是插件替你填掉的：

- **桌面版是前端二次渲染**，经典选择器抓不到，必须走移动版 `/mo/q/m`；
- **翻页不能复用会话**，同一上下文里连翻 `pn=0 → 30 → 60` 会被判成机器人弹验证码，必须一页一个上下文；
- **`pn` 是楼层偏移不是页码**，写 `pn=2` 返回空页。

## 与 DSH 的集成方式

| 面 | 用什么 |
|---|---|
| 工具 | `ctx.tools.register`：`tieba_thread` / `tieba_status` / `tieba_bars` |
| 设置页 | 客户端插件 `ctx.slots.inject('settings.section', …)` |
| HTTP | `ctx.webServer` 挂 `/tieba/api/*`（只服务设置页） |
| 装配 | `dsh.bundle.patch` 插入 `id: tieba` 一行 |
| 展示 | `locale/*.json` 的 `meta.title` / `meta.description` |

## 安全

`/tieba/api/*` 沿用 DSH 自己 `/api` 的信任模型：**认 Host，不认连接地址**。

- 默认只接受回环地址（`127.0.0.1` / `::1` / `localhost`）；
- `sec-fetch-site: cross-site` 一律拒绝；带 `Origin` 时必须与 `Host` 同源（挡 CSRF）；
- **公网 / 反向代理 / 网关插件部署**：请求的 Host 是你的域名。**如果 DSH 本身已经用 `--trusted-host <域名>` 启动（网关/反代部署必然配过），插件会自动沿用那份白名单**，不用额外配置；否则显式放行：

  ```bash
  export DSH_TIEBA_TRUSTED_HOST=tieba.example.com   # 多个用逗号分隔
  ```

  403 的响应体里会带上你的 Host 和这句提示，照着设置就行。为什么不看 `X-Forwarded-For`：代理后面所有请求都来自 `127.0.0.1`，按连接地址判会把本地访问也误杀。

> **职责边界**：身份认证不归这个插件，由前面的网关 / 反向代理负责。插件只做**同源校验**（Host 白名单 + `sec-fetch-site` + `Origin`）——那不是鉴权，是挡 CSRF：网关通常靠 cookie 认人，不拦同源的话，恶意网页可以借你的浏览器打 `/tieba/api/login/start`。
>
> 相应地，部署时要保证 **DSH 的 webServer 只对网关可见**（绑 `127.0.0.1`，或防火墙只放网关的 IP）。否则绕过网关直接连端口，前面那层鉴权就白做了。

对外只交流 `application/json` 与 `image/png`（登录二维码），不提供文件下载或 HTML 通道；请求体上限 64KB。

> **cookie 是明文 JSON**（`~/.dsh-tieba/cookies.json`，`0600`），等价于你的贴吧登录态：别提交、别共享、别贴截图。
>
> **别整份贴 `dsh --dump-config`**：它会把插件 config 原样展开，里面有 cookie 和本机路径。

## 已知限制

- **只读**，没有发帖 / 回复 / 签到 / 关注
- 移动版单页上限 30 层，超过靠 `pn` 偏移翻页
- 登录态会过期（`BDUSS` 通常能撑几个月），失效时 `tieba_status` 明确报 `expired`
- 「热门回复」区块未实现，目前用楼中楼代替
- 图片压缩依赖系统 `ffmpeg` / `ffprobe`：没装不会报错，只是跳过压缩
- 抓取受百度风控影响，请求间隔别调太小
- **原图可能拿不全**：桌面页懒加载，个别图取不到签名地址，这时只给缩略图
- **`tieba_bar` 依赖前端结构**：选择器失效时列表会空，改 `config.selectors` 即可

## 与其他插件共存

本插件**不声明任何 `@deepseek-ai/*` 依赖，也不 import 宿主包**——工具定义由本地生成（`lib/tool-schema.mjs`）。

原因是踩过坑：`@deepseek-ai/dsh-tools` 里的 `TOOL_RUNTIME_SCHEDULER` 是模块内 `Symbol(...)`。只要它被装进 profile（**声明 peer 就够了，pnpm 会自动安装**），进程里就有两份，宿主查 `ctx.tools[symbol]` 得到 undefined：

```
Cannot read properties of undefined (reading 'prepare')
```

**每次工具调用都会失败**，还会留下孤儿 `tool_calls`，之后每轮 400。详见 [deepseek-harness#1486](https://github.com/deepseek-ai/deepseek-harness/discussions/1496)。

遇到这个报错时，它**不是本插件造成的**（连 import 都没有），排查：

```bash
cd ~/.dsh/profiles/<profile> && pnpm why @deepseek-ai/dsh-tools
```

会列出哪个插件声明了它。临时恢复（重启生效）：

```bash
rm -rf ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai
```

但只要那个插件还在，下次 `pnpm add` 又会装回来。根治两条：卸掉该插件，或关掉 peer 自动安装：

```bash
echo "auto-install-peers=false" >> ~/.dsh/profiles/<profile>/.npmrc
```

## 项目结构

```text
dsh-plugin-tieba/
├── lib/
│   ├── index.js          # 宿主半边：注册工具、挂 HTTP 路由
│   ├── client.js         # 浏览器半边：手写的经典脚本，不是构建产物
│   ├── core.mjs          # 内核：登录态、全量翻页、抽样、图片压缩
│   ├── browser.mjs       # 定位磁盘上或系统的 chromium
│   ├── server.mjs        # 设置页用的 HTTP 接口
│   ├── config-store.mjs  # 配置读写
│   └── paths.mjs         # 运行期路径
├── src/{cli,login}.mjs   # 命令行与扫码登录
├── locale/{en,zh}.json   # 插件展示元信息
├── scripts/check-browser.mjs
└── cordis.patch.yml      # bundle 层：插入 id: tieba 这一行
```

## 开发

改代码前先看 [AGENTS.md](./AGENTS.md)：那里有客户端产物的硬约束（必须是经典脚本，不能出现 `import`/`export`）、宿主侧不能静态 import `@deepseek-ai/*` 的原因、浏览器解析顺序、以及怎么验证改动。

一句话版本：`lib/client.js` 手写、保持 `window.__ModuleLoader__.load({id, factory})` 外壳；改完重启 DSH 才生效。

## 彩蛋

<details>
<summary>真实使用现场（点开）</summary>

<img src="docs/demo.png" width="720" alt="在 DSH 里让它去 deepseek 吧读几个帖子之后的输出">

> 截图里是贴吧用户的原始发言摘要，不代表本项目立场；昵称与帖子 id 都没有处理。

</details>

## 许可

MIT
