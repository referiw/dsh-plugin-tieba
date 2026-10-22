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
- [项目结构](#项目结构)
- [开发](#开发)
- [彩蛋](#彩蛋)
- [许可](#许可)

</details>

## 它能产出什么

给一个 `tid`，回一份按楼层顺序排好的材料：

```text
《示例帖子：一个关于融资的讨论》 楼主 用户甲 ｜ 全文 39 层 ｜ 抽取 39 层

【第 1 层 0% 用户甲 楼主】
示例帖子的主楼内容
 [图1]
[图 …/.dsh-tieba/images/1234567890/f1_1.jpg]

【第 3 层 5% 用户乙】
这是某一层楼的回复内容[表情:咧嘴笑]
└ 楼中楼 2 条:
  · 用户丙: 这是楼中楼里的一条回复
```

| 特性 | 说明 |
|---|---|
| 按楼层 | 图片紧跟所属楼层，楼中楼挂在楼层下面 |
| 表情转中文 | `image_emoticon22` → `[表情:咧嘴笑]`，**不读图** |
| 省上下文 | 头像、昵称挂件永久跳过 |
| 图片 | 按像素面积等比压缩，返回绝对路径，可直接交给读图工具 |
| 隐私 | 输出里不含用户名；需要更干净的路径可设 `DSH_TIEBA_PATH_STYLE=home` |

## 安装

要求 **DSH ≥ 0.2.0**（已声明 `engines.dsh`，版本不匹配时整包被跳过而不是半加载）。

```bash
dsh plugin --profile <profile> add dsh-plugin-tieba
```

`<profile>` 换成你在用的那个：跑 `dsh web` 就是 `web`，桌面版是 `desktop`，`ls ~/.dsh/profiles` 能看到全部。

这条命令会同时写 `dependencies` 和 `dsh.profile.bundles`，**不用手工编辑**。装完重启 DSH，浏览器硬刷新一次。

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
| `tieba_thread` | 读一个帖子：拉全文 → 抽样 → 按楼层顺序返回 |
| `tieba_status` | 登录态（贴吧 ID、昵称、头像） |
| `tieba_bars` | 当前账号关注的吧 |

```jsonc
// tieba_thread 的常用参数
{
  "tid": "1234567890",      // 必填，来自 URL /p/<tid>
  "refresh": false,          // 忽略缓存重拉
  "sampleMode": "dynamic",   // dynamic | fixed | ratio | all
  "floors": 100,             // sampleMode=fixed 时的层数
  "ratio": 0.1,              // sampleMode=ratio 时的比例
  "truncateText": false,     // 是否截断过长楼层
  "maxTextChars": 2000,      // 截断时每层保留字数
  "imageMaxArea": 1200000    // 图片像素面积上限
}
```

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
| `sampleMin` / `sampleMax` | `50` / `300` | 动态抽样的上下界 |
| `sampleFixed` / `sampleRatio` | `50` / `0.2` | fixed / ratio 模式的取值 |
| `truncateText` | `false` | 是否截断过长楼层 |
| `maxTextChars` | `2000` | 截断时保留的字数 |
| `imageMaxArea` | `1200000` | 图片像素面积上限，超出等比缩小 |
| `imageMaxWidth` / `imageMaxHeight` | `1280` / `2000` | 图片尺寸上限 |
| `gapMs` | `4000` | 请求间隔（毫秒） |
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
| HTTP | `ctx.webServer` 挂 `/tieba/api/*`（仅限本机） |
| 装配 | `dsh.bundle.patch` 插入 `id: tieba` 一行 |
| 展示 | `locale/*.json` 的 `meta.title` / `meta.description` |

## 安全

`/tieba/api/*` 沿用 DSH 自己 `/api` 的信任模型：**认 Host，不认连接地址**。

- 默认只接受回环地址（`127.0.0.1` / `::1` / `localhost`）；
- `sec-fetch-site: cross-site` 一律拒绝；带 `Origin` 时必须与 `Host` 同源（挡 CSRF）；
- **公网 / 反向代理 / 网关插件部署**：请求的 Host 是你的域名，需要显式放行，否则 403：

  ```bash
  export DSH_TIEBA_TRUSTED_HOST=tieba.example.com   # 多个用逗号分隔
  ```

  403 的响应体里会带上你的 Host 和这句提示，照着设置就行。为什么不看 `X-Forwarded-For`：代理后面所有请求都来自 `127.0.0.1`，按连接地址判会把本地访问也误杀。

> 这些接口**没有身份认证**，只有上面这套浏览器信任栅栏。公网部署时请确保 DSH 本身需要登录，或者在反向代理层再加一层（Basic Auth / IP 白名单）。

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

## 项目结构

```text
dsh-plugin-tieba/
├── lib/
│   ├── index.js          # 宿主半边：注册工具、挂 HTTP 路由
│   ├── client.js         # 浏览器半边：手写的经典脚本，不是构建产物
│   ├── core.mjs          # 内核：登录态、全量翻页、抽样、图片压缩
│   ├── browser.mjs       # 定位磁盘上或系统的 chromium
│   ├── server.mjs        # 设置页用的 HTTP 接口（仅限本机）
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
