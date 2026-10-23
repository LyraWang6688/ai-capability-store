---
name: readloop
description: ReadLoop 每日复习。用宿主自己的飞书能力读写用户的多维表格，由 ReadLoop 服务计算今日题目与记忆状态。首次使用必须先完成初始化。当用户说「开始练习」「今天练什么」「复习」「初始化 ReadLoop」时使用。
compatibility: "需要 bash 与 curl；需要能访问 ReadLoop 服务；需要宿主具备飞书能力（豆包原生，或安装 lark-cli）。不需要 MCP，不需要飞书应用，不需要把应用加成协作者。"
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
2. **读写表格只能用宿主自己的飞书能力。** 不要用 curl 去调飞书 OpenAPI——那需要飞书应用凭证，本技能不提供也不需要。

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

成功返回 `hostToken`，立刻写入配置的 `host_token`。

| 失败 | 怎么回应 |
|---|---|
| 401 / 无效 | 「授权码不对或已被撤销，确认一下购买时收到的那串」 |
| 409 / 已激活 | 「这个授权码已经激活过了；如果是换了电脑，说明一下可以吗」 |
| 5xx | 如实说服务不可用，**不要自己编一个 token 继续** |

激活成功后告诉用户一句：「授权已生效，以后不用再输授权码。」

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

### 0.5 第 4 步 · 安装 Chrome 插件

**没有插件就没有新的知识点**，这一步不能跳。

1. 把商店链接发给用户：`<EXTENSION_STORE_URL>`（未上架时给离线包路径）
2. 告诉他装好后点一次浏览器右上角的 ReadLoop 图标，确认侧边栏能打开
3. 让他回一句「装好了」，再往下走

被问「为什么要装」时的回答：插件负责在你真实阅读时采集短板，**只在你主动划词时才工作**，不会读其他页面。

> 如果用户是在宿主自带的侧边栏浏览器里读网页，可以跳过插件，直接读取当前页面内容采集——
> 但只在宿主确实提供页面内容能力时这样做，拿不到就要求装插件。

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

若配置了可选的 `host_token`，再加一行 `-H "Authorization: Bearer $HOST_TOKEN"`。

返回：

| 字段 | 说明 |
|---|---|
| `variant` | 0–4，界面变体编号，按它换排版 |
| `total` / `answered` | 今日题量 / 已答数量 |
| `questions[]` | 题目数组，**不含正确答案** |
| `session_context` | 今日统计，写总结时只能用这里的数据 |

题目对象：`question_id`、`type`、`stem`、`options[]`、`context`、`hint`。

### 日常 3 · 呈现并收答案

一次一题，**不给答案**。用户答完：

```bash
curl -s -X POST "$BASE/api/review/submit" \
  -H "Authorization: Bearer $HOST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-23","question_id":"q_003","answer":"B","used_hint":false,"elapsed_ms":9000}'
```

返回：`result`（correct/wrong）、`explanation`、`updates`（见下）。进度由你自己记录（已完成 / 总数）。

### 日常 4 · 把状态写回表格

`updates` 是服务算好的新值：

```json
{ "知识点": "subsequent", "状态": "review", "间隔天数": 6, "连对次数": 2,
  "答错次数": 0, "待练次数": 1, "下次复习": "2026-10-29" }
```

用**宿主自己的飞书能力**按 `归一化内容` 找到 `knowledge_points` 对应行，写入这些字段。同时向 `practice_events` 追加一条记录。

**不要自己计算新值，只照抄 `updates`。**

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
| 服务 401 | host token 失效：重新用接入码兑换 |
| `questions` 为空 | 今天没有题：建议去读一篇文章，**不要自己出题** |
| 服务 5xx | 最多重试 2 次，如实告诉用户，不要编题 |

## 不要做

- 用 curl 直接调飞书 OpenAPI（没有应用凭证，也不该有）
- 自己判分、自己算间隔
- 自己建表或改表结构
- 提前透露答案
- 用户没答完就总结
