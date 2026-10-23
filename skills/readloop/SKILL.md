---
name: readloop
description: ReadLoop 每日复习。用宿主自己的飞书能力读写用户的多维表格，由 ReadLoop 服务计算今日题目与记忆状态。首次使用必须先完成初始化。当用户说「开始练习」「今天练什么」「复习」「初始化 ReadLoop」时使用。
compatibility: "需要 bash 与 curl；需要能访问 https://readinsight.bamamei.online 与 open.feishu.cn。出机内容：当天候选知识点、你的作答、你的模型配置（含 API Key，仅当次使用，服务不保存）；首次配置的写入校验由 ReadLoop 服务端代跑（宿主不直接调飞书 OpenAPI）。需要宿主具备飞书能力（豆包原生，或安装 lark-cli）。宿主侧不需要 MCP；Chrome 插件写表需要用户自己的飞书应用（初始化第 3 步一键创建）。表格与数据始终在你自己的飞书里。"
---

# ReadLoop

把用户知识库里「今天该练」的短板出成练习题：一次一题，收答案，由服务判分并更新记忆状态。

## 分工（先理解这个，否则会做错）

| 环节 | 谁做 |
|---|---|
| 读写多维表格 | **宿主自己的飞书能力** |
| 选题、算间隔、出题、判分 | **ReadLoop 服务** |
| 数据存储 | 用户自己的飞书表，我们不存 |

**这两个硬约束不能破：**

1. **对错由服务决定。** `submit` 返回的 `result` 是最终结果，不要自己判断、不要改判。
2. **你自己读写表格只能用自己的飞书能力**（不要用 curl 调飞书 OpenAPI）。
   Chrome 插件是另一条通道：它用**用户自建的应用**直连飞书，那是初始化第 3 步配置的，不归你管。

## 宿主适配

### 豆包工作（当前主目标）

- 飞书能力是**原生内置**的，直接用你手上的飞书工具读写多维表格
- **不要建议用户安装 `lark-cli`**，也不需要任何额外授权
- 第一次接入请先按 [`references/doubao-checklist.md`](references/doubao-checklist.md) 跑完冒烟测试

### Codex / Work Buddy 等非字节系宿主

- 先确认已安装并登录飞书 CLI：`lark-cli auth login`
- 读写表格用 `lark-cli base` 系列命令
- 其余流程完全一致

---

## 首次配置（首次必做）

顺序固定，前一步没过不要进下一步。

> **前提**：用户已经购买了 ReadLoop 技能包，手上有一个 8 位授权码。

**① 首次激活 → ② 选模型 → ③ 建多维表格 → ④ 装 Chrome 插件 → ⑤ 建定时任务**

激活是初始化配置的前提：没有 `host_token`，后面的接口一个都调不通。

### 0.1 读本地配置

`~/.readloop/config.json`：

```json
{
  "base_url": "https://readinsight.bamamei.online",
  "host_token": "...",
  "license_expires_at": "2027-10-23T00:00:00+08:00",
  "app_token": "bascn...",
  "model": {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "api_key": "sk-..."
  },
  "schedule": {
    "frequency": "daily",
    "time": "09:00",
    "weekday": null
  }
}
```

五部分（`host_token` / `model` / `app_token` / 插件 / `schedule`）齐了就进入日常流程；缺哪部分补哪部分。

`app_token` 就是多维表格 Base 的 token（`/base/` 后面那段），四张表按名称在里面查找。

### 0.2 第 1 步 · 首次激活（前提）

没有 `host_token` 就什么都做不了，**这一步必须在最前面**。

问用户：「请把你购买 ReadLoop 时拿到的 8 位授权码发我」。

```bash
curl -s -X POST "$BASE/api/license/activate" \
  -H 'Content-Type: application/json' \
  -d "{\"license\":\"$LICENSE_CODE\"}"
```

成功返回 `hostToken` 和 `expiresAt`，两个都写入配置（`host_token` / `license_expires_at`）。

**授权按年计**：`expiresAt` 是硬期限，到期后所有接口返回 402，需要续费重新激活。数据不受影响。

同一个授权码可以在多台机器上重复激活（MVP 不限制次数），换电脑直接再激活一次即可。

| 失败 | 怎么回应 |
|---|---|
| 401 / 无效 | 「授权码不对或已被撤销，确认一下购买时收到的那串」 |
| 5xx | 如实说服务不可用，**不要自己编一个 token 继续** |

激活成功后告诉用户：「授权已生效，有效期到 <expiresAt>，到期前会提醒你续费。」

### 0.3 第 2 步 · 选模型

出题要用大模型，**用用户自己的 API**。

| 预设 | `base_url` | `model` |
|---|---|---|
| **DeepSeek（默认推荐）** | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 豆包方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 由用户提供 |
| 其他 OpenAI 兼容 | 由用户提供 | 由用户提供 |

需要 `base_url` / `model` / `api_key` 三项。用户说不清就默认 DeepSeek，并让他去 DeepSeek 开放平台取 key。

**保存前必须验证一次**（不报鉴权错就算通过）：

```bash
curl -s -X POST "$MODEL_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
```

失败 → 让用户重给，**不要跳过**。

### 0.4 第 3 步 · 建多维表格

问用户：「你的 ReadLoop 多维表格链接发我一下（`/base/` 开头那个）」。

- 拿到 `/base/<app_token>` → 解析出 `app_token`
- 给的是 `/wiki/` 链接 → 让他在飞书里「在表格中打开」后复制 `/base/` 链接

用**宿主自己的飞书能力**列出这个 Base 里的表，**按表名**核对：

| 表 | 必须存在 | 关键字段 |
|---|---|---|
| knowledge_points | ✅ | 归一化内容、状态、待练次数、下次复习 |
| capture_events | ✅ | 采集时间、选中原文、我的译文 |
| practice_events | ✅ | 答题时间、知识点、是否正确 |
| daily_sets | 可选 | 日期、题目 JSON |

**没有表 → 给模板链接让他复制，不要自己建：**

> 打开这个模板 → 右上角「复制」→ 复制到自己的飞书空间 → 把新表链接发我。

用户想换飞书账号也可以——表建在哪个账号下由他决定，你只认链接。

#### 3.3 配置写入通道（一键创建用户自己的飞书应用）

**为什么需要**：Chrome 插件在用户浏览器里，**拿不到你的飞书能力**。它必须有自己的一条通道，才能把划词结果实时写进这张表。

**主路径：一键创建，用户不用进开发者后台**

1. 启动创建（后端用发起方身份帮用户建应用，应用归属用户自己）：

```bash
curl -s -X POST "$BASE_URL/api/setup/app/start" \
  -H "Authorization: Bearer $HOST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"app_token":"'$APP_TOKEN'"}'
```

返回 `{ "session": "...", "verification_url": "..." }`。

2. **把 verification_url 原样贴给用户**，说明：「点开这个链接，在飞书里点『同意』。会在你自己的组织里创建一个你名下的应用。」

3. 轮询（每 3 秒，最多 5 分钟）：

```bash
curl -s "$BASE_URL/api/setup/app/status?session=$SESSION" \
  -H "Authorization: Bearer $HOST_TOKEN"
```

| 状态 | HTTP | 下一步 |
|---|---|---|
| `pending` | 200 | 继续等，并告诉用户在等什么 |
| `completed` | 200 | 创建成功，服务端已自动跑完校验：看 `checks` |
| `expired` | 410 | 让用户重新点一次链接（重新 `start`） |
| `failed` | 200 | 把 `error` 里的原因原样转述给用户 |

**`app_secret` 默认是 `null`，主路径不要读它**——Secret 由插件用配对码自取（第 5 步）。
只有兜底手动路径需要时，才在 URL 后加 `&reveal_secret=1` 取一次。

4. **读三项校验结果**（服务端用新建应用自己的身份自动跑，你不需要、也不应该自己调飞书 OpenAPI）：

```json
{ "token": "ok", "read": "ok", "write": "ok", "publish": "ok", "details": "", "publish_details": "" }
```

| `checks` 项 | 失败说明 | 告诉用户做什么 |
|---|---|---|
| `token` | App ID / Secret 不对或应用未创建成功 | 重新发起创建 |
| `read` | 应用没被加成表格协作者，或没开 `bitable:app` | 表格右上角 `⋯` → 添加文档应用 → 选中刚创建的应用 |
| `write` | 只给了「可阅读」，没给「可编辑」 | 同上，把权限改成**可编辑** |
| `publish` | 自动发布应用版本失败 | 用户手动到开放平台创建并发布版本（不发布权限不生效） |

任何一项失败都要**指出具体是哪一项**，不要笼统说「失败了」。

5. 用户把插件侧边栏里的「一键配置」打开，会显示一个 6 位配对码；**让用户把码发给你**，你只做绑定：

```bash
curl -s -X POST "$BASE_URL/api/setup/app/pair" \
  -H "Authorization: Bearer $HOST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"session":"'$SESSION'","code":"'$PAIR_CODE'"}'
```

返回 `{ "paired": true }` 即绑定成功。**这一步不会把 Secret 给你**：插件会在下一次轮询时自己用
`GET /api/setup/app/pair?code=<配对码>` 一次性取走凭证，服务端随即删除。

- 400：配对码不是 6 位数字 / 会话还没 `completed` / 码已被占用
- 404：会话不存在；410：会话过期；429：尝试次数过多（让用户重新点「一键配置」）

**绝对不要**把 App ID / Secret 写进 `~/.readloop/config.json`，也不要打印到对话里——它属于插件，不属于你。

**兜底：手动创建**（`/api/setup/app/start` 返回不可用、或用户明确要求手动时）

1. 开放平台 → 创建企业自建应用 → App ID / Secret
2. 开通 `bitable:app`（自动补选项再加 `base:field:update`）
3. **创建版本并发布** — 不发布权限不生效，最容易漏
4. 表格右上角 `⋯` → 添加文档应用 → 设为**可编辑**
5. 让用户把 App ID / Secret / 表格链接填进插件设置

**常见失败**：

| 现象 | 原因 |
|---|---|
| 读表返回 403 | 没加成协作者，或没开 `bitable:app` |
| 能读不能写 | 只给了「可阅读」，要改成「可编辑」 |
| 字段选项不存在 | 缺 `base:field:update` 权限 |

**绝对不要**把 App Secret 写进 config.json，也不要留在对话里——交付插件后即作废。

### 0.5 第 4 步 · 安装 Chrome 插件

**没有插件就没有新的知识点**，这一步不能跳。

1. 把商店链接发给用户：`<EXTENSION_STORE_URL>`（未上架时给离线包路径）
2. 告诉他装好后点一次浏览器右上角的 ReadLoop 图标，确认侧边栏能打开
3. 让他回一句「装好了」，再往下走

被问「为什么要装」时的回答：插件负责在你真实阅读时采集短板，**只在你主动划词时才工作**，不会读其他页面。

**两条采集入口，插件是主路径**

| 场景 | 怎么做 |
|---|---|
| 用户自己浏览器里阅读（默认） | 走 Chrome 插件：划词 → 侧边栏 → 你的翻译 + AI 对比 |
| 用户直接在宿主里打开网页 | 用你自己的页面读取能力拿当前内容：**给选区就直接用**；只给整页就先问「你想练哪一段」 |

插件仍是必装项——它覆盖大部分场景，且不受宿主能力限制。用户问「能不能不装」，回答：可以在宿主里读，但**装插件才是完整的阅读体验**。

### 0.6 第 5 步 · 建定时任务

**这一步决定用户会不会每天被想起来。** 不能跳过。

问两个问题（可给默认值，但要让用户确认）：

| 配置 | 选项 | 默认 |
|---|---|---|
| 频率 | 每天 / 每周（指定星期几） | 每天 |
| 时间 | 任意整点或半点，如 `09:00` / `21:00` | `09:00` |

拿到答案后，生成一段**用户可直接粘贴的任务描述**，例如每天 9 点：

> 每天 09:00 执行 ReadLoop 每日练习：读取我的多维表格，取今日题目，陪我逐题作答。

每周一、三、五 21 点时：

> 每周一、三、五 21:00 执行 ReadLoop 每日练习：读取我的多维表格，取今日题目，陪我逐题作答。

然后**用宿主自己的定时任务能力直接创建**：

| 参数 | 值 |
|---|---|
| 频率 | 用户选的（每天 / 每周几） |
| 时间 | 用户选的 |
| 任务描述 | 上面生成的那段 |

1. 调用宿主的定时任务 / 提醒创建能力，带上这三个参数
2. **读回创建结果**，确认任务确实存在（有任务 ID / 列表就查一次）
3. 把「每天 09:00 会来找你练题」告诉用户

写进配置的 `schedule` 段：

```json
{"frequency":"daily","time":"09:00","weekday":null}
{"frequency":"weekly","time":"21:00","weekday":[1,3,5]}
```

创建失败时明确说清楚，**不要假装已创建**。

### 0.7 写入配置并自检

```bash
mkdir -p "$HOME/.readloop"
chmod 600 "$HOME/.readloop/config.json"
```

五部分都齐了才算配置完成：**授权 `host_token` / 模型 / 表格 / 插件 / 定时任务**。
**任何一步没成功，明确告诉用户卡在哪，不要假装完成。**

---

## 日常流程

### 日常 1 · 读候选知识点

用**宿主自己的飞书能力**读 `knowledge_points`，只取 `状态` 不是 `mastered` 的行。

需要带给服务的字段：`归一化内容`、`类型`、`释义`、`状态`、`间隔天数`、`难度因子`、`连对次数`、`答错次数`、`待练次数`、`下次复习`、`来源原句`。

### 日常 2 · 让服务算今日题

```bash
curl -s -X POST "$BASE/api/review/today" \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-23","model":'"$MODEL_JSON"',"points":[...第 1 步读到的行...]}'
```

`model` 就是配置里的那段（`provider` / `base_url` / `model` / `api_key`），**每次请求都要带**——服务端不保存用户模型配置。
当前版本的题面由服务端确定性生成，**不会真的调用模型**（`model` 必填是为了将来润色，传了不产生调用）。

每次请求都要带 `-H "Authorization: Bearer $HOST_TOKEN"`。

返回：

| 字段 | 说明 |
|---|---|
| `variant` | 0–4，界面变体编号，按它换排版 |
| `total` | 今日题量 |
| `answered` | **恒为 0**：服务端不记进度，进度由你自己数（每成功 submit 一次 +1） |
| `questions[]` | 题目数组，**不含正确答案** |
| `session_context` | 今日统计，写总结时只能用这里的数据 |

题目对象：`question_id`、`type`、`stem`、`options[]`（仅选择题，4 个）、`context`、`hint`。

- `context` **当前恒为 `null`**：作答前不下发原句（会泄露答案），语境已经在掩码后的 `stem` 里。不要把它当原句渲染。
- `question_id` 有效期 48 小时；过期或被改过会返回 400，此时**重新取一次今日题**，不要自己编题。

### 日常 3 · 呈现并收答案

一次一题，**不给答案**。用户答完：

```bash
curl -s -X POST "$BASE/api/review/submit" \
  -H "Authorization: Bearer $HOST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-23","question_id":"eyJ2IjoxLCJkIjoi...","answer":"B","used_hint":false,"elapsed_ms":9000}'
```

`answer` 的写法：**选择题可以传选项原文，也可以传 `A`/`B`/`C`/`D`**（服务端按题目里的选项映射，两种都判对）；
**填空题必须传用户输入的原文**。不要自己做判分或预处理。

返回：`result`（correct/wrong）、`grade`（again/hard/easy/good）、`explanation`、`updates`（见下）。进度由你自己记录（已完成 / 总数）。

### 日常 4 · 把状态写回表格

`updates` 是服务算好的新值（**10 个字段**）：

```json
{ "知识点": "subsequent", "归一化内容": "subsequent", "状态": "review", "间隔天数": 6,
  "难度因子": 2.5, "连对次数": 2, "答错次数": 0, "待练次数": 1,
  "下次复习": "2026-10-29", "最近暴露": "2026-10-23" }
```

用**宿主自己的飞书能力**按 `归一化内容` 找到 `knowledge_points` 对应行，把上面这些字段全部写回
（**`难度因子` 不写回会丢**；`最近暴露` 是出题日期）。同时向 `practice_events` 追加一条记录。

**不要自己计算新值，只照抄 `updates`。** 同一题重复提交返回同一组 `updates`，重写同样值无副作用。

---

## 两种运行模式

### A. 定时任务（用户不在场）

1. 跑第 1、2 步
2. 只取 1 题做预览，报告总题数
3. 发一句提醒
4. **不要一次性列出全部题目**

### B. 用户开始答题

循环第 3、4 步直到全部答完，然后写今日总结。

## 今日总结

只能用 `session_context` 里的字段：

```
今天练了 {total} 题，{correct} 对 {wrong} 错。
今日新暴露 {new_count} 个，待复习 {due_count} 个。
最需要留意：{weak_points}
```

## 出错时

| 情况 | 怎么做 |
|---|---|
| 配置缺失 | 回到第 0 步 |
| 表格字段不符 | 按 `schema.md` 说明缺哪张表/哪个字段，不要自己改表 |
| 服务 401 | host token 失效：重新用授权码激活 |
| 服务 402 | 年度授权到期：提示续费，**数据不动、不要重装** |
| `questions` 为空 | 今天没有题：建议去读一篇文章，**不要自己出题** |
| submit 返回 400（题目无效/过期） | 重新调一次 today 取新题，不要把旧 `question_id` 重试 |
| setup 返回 404 / 410 | 创建会话不存在或已过期：重新调 `start`，再让用户点一次验证链接 |
| setup 返回 429 | 配对尝试过多：让用户重新点插件里的「一键配置」生成新配对码 |
| 服务 5xx | 最多重试 2 次，如实告诉用户，不要编题 |

## 不要做

- 用 curl 直接调飞书 OpenAPI（没有应用凭证，也不该有；写入通道的校验由服务端做）
- 自己判分、自己算间隔、自己数 `updates` 之外的字段
- 自己建表或改表结构
- 提前透露答案（`context` 为 `null` 时也不要去猜原句）
- 把 `app_secret` / `app_id` 写进配置文件或打印到对话里
- 用户没答完就总结
