# 变更记录

只记对外可见的行为变化。完整细节看 `git log`。

## 0.3.5

**修复 `tieba_bar` 返回非法 JSON**

- `isTop` 不再产出 `undefined`。宿主的 lossless-JSON 校验要求输出可无损往返，对象里留一个 `undefined` 就会让整个列表被判无效（`returned invalid output: value is not lossless JSON`），33 条里只要有 1 条非置顶就全废。
- 工具出口统一 `stripUndefined()`，同类问题不再可能复发。
- README 补「从 GitHub 安装」，写明 `dsh plugin add` 失败时会回滚 manifest 与锁文件、但不清理 `node_modules`，导致下一次 `pnpm install` 悄悄降级。

## 0.3.4

**可在没有 `webServer` 的宿主里激活**

- `inject` 只保留 `tools`；`webServer` / `webStartup` 改为 `ctx.get()` + `ctx.inject()` 惰性获取。此前在 onebot-hub 给 QQ 另起的 agent 作用域里，插件因缺 `webServer` 完全不激活，工具注册不上。
- 注意：**不能**写成 `inject = { required, optional }`——cordis 会把对象的键当成服务名，去找叫 `required` 的服务，插件直接不激活。
- CLI：图片行改用 `thumb` / `original` 字段（此前一直输出 `undefined`）；新增 `bar` 子命令与 `--images`。
- `imageQuality: original | both` 拿不到原图时返回 `originalUnavailable: true`，不再静默降级。

## 0.3.3

- `tieba_bar` 带上置顶帖（置顶在独立的 `.top-thread-card` 容器里，不在普通卡片列表内）。置顶条没有作者/回复数，字段为 `null`。

## 0.3.2

- 修正原图获取：移动页缩略图 URL 的 `?src=` 参数没有签名，取回来是 238×238 占位图。改为读桌面页的 `pic/item` 地址，并按**文件名**与缩略图对齐；下载必须走浏览器请求上下文（Node 的 `fetch` 无指纹，同样拿到占位图）。

## 0.3.1

- 新增 `tieba_bar`：吧内帖子列表（最新 / 最热 / 精华 + 分页）。列表是虚拟滚动，边滚边抽、按 tid 去重累积。
- 选择器全部可配（`config.selectors`），前端改版时改配置即可，不用等发版。

## 0.3.0

- 帖子输出顶部加楼主的发帖时间（全贴只此一处），相对时间归一成 `YYYY-MM-DD HH:MM`。
- 楼层号改用页面给的 `floor_num`，删楼时不再错位。
- 图片给三档：`thumb`（默认）/ `original`（按需）/ `url`（外链）。
- 默认值收紧：`sampleMax` 300→120、`truncateText` 默认开、`maxTextChars` 2000→600。
- 文档：桌面版的 `desktop` profile 由 Electron 独占，命令行会被拒绝，改推设置页安装。

## 0.2.7

- 不再声明、也不再 import 任何 `@deepseek-ai/*`，工具定义本地生成。原因见下一条。

## 0.2.6（已废弃）

- 试图对齐社区写法：宽范围 peer + 静态 import。**无效**——pnpm 会自动安装 peer，profile 里出现第二份 `dsh-tools`，工具调用报 `reading 'prepare'`。

## 0.2.5

- 去掉全部宿主包声明与 import，包括 `cordis` 的 peer。

## 0.2.4（已废弃）

- 回到静态 import，peer 收窄为精确版本。**在装了其他带 `@deepseek-ai/*` 依赖的机器上会被 pnpm 自动补装**，引出双实例问题。

## 0.2.3（未发布）

- 回退静态 import，恢复本地 schema 编译。

## 0.2.2（已废弃）

- 把 `@deepseek-ai/dsh-tools` 放进 `dependencies`。**这是错的**：它自身带十几个 host peer，装进 profile 要么缺 peer 直接 `ERR_MODULE_NOT_FOUND`，要么造成双实例；官方 advisory（deepseek-harness#1496 的建议 9）明确说插件不应直接依赖框架内部包。

## 0.2.1

- 工具改用本地编译的 JSON Schema，绕开注册失败导致的整轮请求被拒。
- 设置页接口的信任模型改为 Host 白名单，支持网关 / 反向代理部署；自动沿用 DSH 自己的 `--trusted-host`。
- 二维码并入轮询响应，去掉独立的图片路由。

## 0.2.0（已废弃）

- `@deepseek-ai/dsh-tools` 只声明为 peer 却从未被安装，`parameters` 原样透传成 `{}`，API 以 `Invalid schema for function` 拒掉**整轮请求**——不只是工具不可用，是对话卡死。

## 0.1.0

首个可用版本：扫码登录、读主题帖（楼层 / 楼中楼 / 表情 / 图片）、动态抽样、只读。
