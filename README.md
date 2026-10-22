# dsh-plugin-tieba

**只读**百度贴吧的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把一整栋楼读成一份带图的结构化材料，交给 agent 去读。

不发言、不点赞、不签到、不关注。只读。

<img src="docs/settings.png" width="720" alt="设置页：登录状态、抽样策略、输出截断、图片压缩、请求节流">

> 设置页里能调完所有东西：登录状态、抽样方式、是否截断、图片压到多大、请求多慢。改完即时生效。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0-blueviolet.svg)

---

## 为什么需要它

贴吧是个反爬做得很扎实的地方，常见做法都会撞墙：

- **裸 cookie 重放无效。** `BDUSS` / `STOKEN` 齐全也没用，`dc/common/tbs` 恒返回 `is_login:0`——百度把会话绑在浏览器指纹上。而且那个接口会 301 跳到 `http://`，`BDUSS` 是 `Secure` cookie，压根不会发送。
- **桌面版是前端二次渲染。** `.j_th_tit`、`.threadlist_title` 这些经典选择器全部抓不到，必须走移动版 `/mo/q/m`（服务端渲染）。
- **翻页不能复用会话。** 在同一个浏览器上下文里连续请求 `pn=0 → 30 → 60`，会被判成翻页机器人并弹图形验证码。**每页新开一个上下文**、注入同一份 cookie，就完全正常。
- **`pn` 不是页码。** 帖子里它是**楼层偏移量**（0/30/60），写成 `pn=2` 会返回空页。

这个插件把这些坑都填好了，对外只暴露一件事：给一个 `tid`，拿回可读的楼层。

## 它产出什么

```text
《示例帖子：一个关于融资的讨论》 楼主 用户甲 ｜ 全文 39 层 ｜ 抽取 39 层

【第 1 层 0% 用户甲 楼主】
示例帖子的主楼内容
 [图1]
[图 .dsh-tieba/images/1234567890/f1_1.jpg]

【第 3 层 5% 用户乙】
这是某一层楼的回复内容[表情:15]
└ 楼中楼 2 条:
  · 用户丙: 这是楼中楼里的一条回复
  · 用户丁: 这是楼中楼里的另一条回复
```

- **按楼层顺序**，图片紧跟所属楼层，楼中楼挂在楼层下面
- 表情按文件名映射成中文（`image_emoticon22` → `[表情:咧嘴笑]`），**不读图**
- 头像、昵称挂件永久跳过，不浪费上下文
- 图片按像素面积自动压缩，原始尺寸记录在 `.meta.json`
- **图片路径相对家目录**（不带前导 `/`），输出里不会出现用户名，方便直接贴出去

## 安装

```bash
# 1. 装进 profile
dsh plugin --profile web add dsh-plugin-tieba

# 2. 把包名写进 profile 的 bundles（关键，否则设置里永远是关的）
#    ~/.dsh/profiles/web/package.json → dsh.profile.bundles 追加 "dsh-plugin-tieba"
```

也可以从源码链接安装：

```bash
git clone <repo> ~/dsh-plugin-tieba
cd ~/.dsh/profiles/web && pnpm add link:~/dsh-plugin-tieba
```

首次使用需要登录一次（见下）。

## 登录

贴吧的登录态只能靠真实浏览器拿到。两种方式：

**设置页（推荐）**：DSH → 设置 → 贴吧 → 重新扫码登录，二维码直接显示在页面里，扫完自动变「已登录」。

**命令行**：

```bash
node src/login.mjs
```

cookie 落在 `~/.dsh-tieba/cookies.json`（`0600`），可用 `DSH_TIEBA_HOME` 改目录。

## 工具

| 工具 | 作用 |
|---|---|
| `tieba_thread` | 读一个帖子：拉全文 → 抽样 → 按楼层顺序返回 |
| `tieba_status` | 登录态（贴吧 ID、昵称、头像 URL） |
| `tieba_bars` | 当前账号关注的吧 |

`tieba_thread` 的常用参数：

```jsonc
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

默认**动态抽样**：楼层越多，比例越低，结果夹在 `[min, max]` 之间。

| 总楼层 | 抽多少 | 比例 |
|---:|---:|---:|
| ≤ 50 | 全读 | 100% |
| 100 | 65 | 65% |
| 300 | 125 | 42% |
| 1000 | 230 | 23% |
| > 1000 | 300（封顶） | < 30% |

**楼主楼层始终补齐**，不占抽样名额。匿名帖没有用户名可匹配，第 1 层恒判为楼主。

## 配置

设置页可改，也可直接编辑 `~/.dsh-tieba/config.json`（改完即时生效，无需重启）。

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

不想装插件也可以直接用：

```bash
tieba status                    # 登录态
tieba thread 1234567890         # 读帖
tieba thread 1234567890 --json  # 结构化输出
tieba thread 1234567890 --no-sample --max-chars 500
```

## 安全

**所有 `/tieba/api/*` 接口仅限本机访问。** 判据不是只看 `remoteAddress`——反向代理转发时连接同样来自
`127.0.0.1`，公网请求会被误判成本机。所以要求同时满足：

1. 连接来自回环地址（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）；
2. **没有任何转发头**（`X-Forwarded-For` / `X-Real-IP` / `Forwarded` / `X-Forwarded-Host`）。

不满足返回 `403 {"error":"forbidden: local access only"}`。

插件对外只交流两种内容：`application/json`（文字）与 `image/png`（登录二维码）。不提供文件下载、
HTML 或其它二进制通道；请求体上限 64KB。

## 已知限制

- **只读。** 不提供发帖、回复、签到、关注等写操作。
- **移动版单页上限 30 层**，超过要靠 `pn` 偏移翻页。
- **登录态会过期**，`BDUSS` 通常能撑几个月；失效时 `tieba_status` 会明确报 `expired`。
- **热门回复未实现。** 贴吧的「热门回复」区块在测试过的帖子里始终为空，目前用楼中楼代替。
- 抓取行为受百度风控影响，请求间隔别调得太小。

## 项目结构

```
dsh-plugin-tieba/
├── lib/
│   ├── index.js          # DSH 插件入口（注册工具）
│   ├── core.mjs          # 内核：登录态、全量翻页、抽样、图片压缩
│   ├── server.mjs        # 设置页用的 HTTP 接口（仅限本机）
│   ├── client.js         # 设置页 UI（浏览器半侧）
│   ├── config-store.mjs  # 配置读写
│   ├── paths.mjs         # 运行期路径
│   └── emoticon-names.json
├── src/
│   ├── cli.mjs           # 命令行
│   ├── login.mjs         # 扫码登录
│   └── dump-cookies.mjs
├── cordis.patch.yml
├── AGENTS.md             # 给 agent 看的工程说明
└── README.md
```

## 许可

MIT
