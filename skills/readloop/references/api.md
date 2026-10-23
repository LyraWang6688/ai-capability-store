# 接口契约

服务只做计算，**不存储用户数据**。表格读写全部由宿主用自己的飞书能力完成（Chrome 插件那条通道例外，见第 5 节）。

- 生产地址：`https://readinsight.bamamei.online`（下称 `BASE`；本地调试可指向 `http://127.0.0.1:3000`）
- 除 `activate` 与「插件取凭证」外，所有请求带 `Authorization: Bearer <host_token>`
- 响应统一信封：成功 `{ "success": true, "data": … }`，失败 `{ "success": false, "error": { "code", "message" } }`

---

## 1. POST /api/license/activate

用购买时拿到的 8 位授权码换 `host_token`。**这是所有其他接口的前提。**

**不限制激活次数**：同一个授权码可以在多台机器上重复激活，每次返回一个新的 `host_token`，旧 token 不强制失效。

请求（授权码可带空格/连字符，服务端会归一化）：

```json
{ "license": "ABCD2345" }
```

返回：

```json
{ "hostToken": "...", "expiresAt": "2027-10-23T00:00:00+08:00" }
```

**授权按年计，`expiresAt` 是硬期限。** 到期后 token 失效，所有业务接口返回 402，用户需续费重新激活（数据不受影响）。

| 状态码 | 含义 |
|---|---|
| 400 | 缺少 `license`，或格式不对 |
| 401 | 授权码校验不通过（拼错 / 非本服务签发） |
| 503 | 服务端未配置授权密钥（部署问题） |
| 5xx | 服务不可用 |

---

## 2. POST /api/review/today

宿主把候选知识点和**用户的模型配置**一起传给服务，服务选出今日题目并签发 `question_id`。

请求：

```json
{
  "date": "2026-10-23",
  "model": {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "api_key": "sk-..."
  },
  "points": [
    {
      "知识点": "subsequent",
      "归一化内容": "subsequent",
      "类型": "word",
      "释义": "随后的",
      "状态": "review",
      "间隔天数": 3,
      "难度因子": 2.5,
      "连对次数": 1,
      "答错次数": 0,
      "待练次数": 2,
      "下次复习": "2026-10-23",
      "来源原句": "……"
    }
  ]
}
```

- `model`：**必填**，服务端会校验（必须 https、不能指向内网）。当前版本的题面由服务端**确定性生成**，不调用模型；`model` 是为将来的模型润色预留，传了也不会产生模型调用。
- `points`：**不能为空**；`状态` 用英文枚举（`new` / `learning` / `review` / `relearning` / `mastered`）；数字字段接受数字或数字字符串；`下次复习` 接受 `YYYY-MM-DD`、ISO 8601、毫秒时间戳。
- `date`：`YYYY-MM-DD`（上海时区）；不传则用服务端当天。

返回：

```json
{
  "date": "2026-10-23",
  "variant": 3,
  "total": 8,
  "answered": 0,
  "questions": [
    {
      "question_id": "eyJ2IjoxLCJkIjoi...",
      "type": "choice",
      "stem": "The percentage of students ____ abroad is increasing.",
      "options": ["study", "studying", "studied", "studies"],
      "context": null,
      "hint": null
    }
  ],
  "session_context": {
    "new_count": 2,
    "due_count": 5,
    "weak_points": ["the percentage of", "主谓一致"]
  }
}
```

**两种题型，交互不同：**

| `type` | 呈现方式 | 答对记 |
|---|---|---|
| `choice` | 给出 `options`（4 个），用户选一个 | `good` |
| `cloze` | **不给选项，用户自己输入答案** | `easy`（生成式信号更强） |

- `cloze` 题不要显示选项、不要给答案提示，否则就退化成选择题了。
- `options` 只有 `choice` 有，固定 4 个；顺序不代表答案位置。
- `context` **当前恒为 `null`**：作答前不下发未掩码原句（会直接泄露答案），语境已经写在掩码后的 `stem` 里。不要把它当「原句」渲染。
- `answered` 恒为 `0`：服务端不记进度，宿主自己数已答数（每成功 submit 一次 +1）。
- `hint`：难词（答错 ≥4 次）会给「首字母 + 字母数」，否则 `null`；不要把 hint 当答案。

**`question_id` 是服务端签名的不透明串**，内含知识点、正确答案与作答前状态，客户端不要解析、不要修改、不要缓存到表格。题目对象本身**不含正确答案**。有效期 48 小时（跨天补答仍可判分）。

选题与题面是确定性的：同样的输入与日期，选出同一批知识点、同一题型分配。

| 状态码 | 含义 |
|---|---|
| 400 | `date` 格式不对 / `model` 配置非法 |
| 401 | `host_token` 无效 |
| 402 | 授权到期 |
| 422 | `points` 为空，或某条知识点字段不全 |

---

## 3. POST /api/review/submit

提交一题。服务从 `question_id` 解出答案与知识点，返回判分结果与状态更新。

请求：

```json
{
  "date": "2026-10-23",
  "question_id": "eyJ2IjoxLCJkIjoi...",
  "answer": "B",
  "used_hint": false,
  "elapsed_ms": 9000
}
```

**`answer` 的格式（两种都支持）：**

- 选择题：可以传选项**原文**（如 `"studying"`），也可以传字母 `A` / `B` / `C` / `D`，服务端按题目里的选项映射后判分
- 填空题：传用户输入的**原文**
- 宿主不要自己做任何判分预处理；答案规范化与拼写容错都由服务端完成

返回：

```json
{
  "result": "correct",
  "grade": "good",
  "explanation": "正确答案：subsequent（随后的）。",
  "updates": {
    "知识点": "subsequent",
    "归一化内容": "subsequent",
    "状态": "review",
    "间隔天数": 6,
    "难度因子": 2.5,
    "连对次数": 2,
    "答错次数": 0,
    "待练次数": 1,
    "下次复习": "2026-10-29",
    "最近暴露": "2026-10-23"
  }
}
```

- `result`：`correct` / `wrong`（给用户看的对错）
- `grade`：`again` / `hard` / `easy` / `good`（内部档位，可用于展示）
- **`updates` 必须原样写回表格，不要自己重算。** 共 10 个字段，其中：
  - `难度因子` 会随作答变化，**不写回就会丢**
  - `最近暴露` 取**出题日期**（不是作答当天），这样同一题重复提交返回同一组 `updates`
- **幂等**：同一个 `question_id` 重复提交返回同一组 `updates`，不会重复计分；宿主重写同样的值无副作用
- 用了提示（`used_hint: true`）或答对但 `elapsed_ms > 90000` 会降档为 `hard`

| 状态码 | 含义 |
|---|---|
| 400 | 缺参数；`question_id` 被篡改 / 已过期（48h）/ 不是本服务签发 |
| 401 / 402 | 同其它接口 |
| 5xx | 服务异常，最多重试 2 次；不要编题 |

---

## 4. 初始化接口（一键创建插件写入应用）

> 流程见 `SKILL.md` §3.3。这里只列契约。

### 4.1 POST /api/setup/app/start

用飞书 Device Grant 帮用户创建**属于他自己的**飞书自建应用。

```json
{ "app_token": "bascn..." }
```

返回：

```json
{ "session": "...", "verification_url": "https://...", "expires_at": "2026-10-23T22:10:00+08:00" }
```

`app_token` 只接受纯 token（`/base/<token>` 里那段）。传整条链接会返回 400，**宿主自己解析 URL**。创建失败/无法启动返回 503。

### 4.2 GET /api/setup/app/status?session=…

```json
{
  "status": "pending",
  "verification_url": "https://...",
  "expires_at": "…",
  "checks": null,
  "app_id": null,
  "app_secret": null,
  "error": null
}
```

| `status` | HTTP | 含义 |
|---|---|---|
| `pending` | 200 | 等用户在飞书点「同意」 |
| `completed` | 200 | 已创建并跑完三项校验；`checks` 有值 |
| `expired` | 410 | 会话超过 10 分钟（body 里 `status` 仍是 `expired`） |
| `failed` | 200 | 创建失败，`error` 给可读原因 |

| 状态码 | 含义 |
|---|---|
| 400 | 缺 `session` 参数 |
| 404 | 会话不存在或已失效 |
| 410 | 会话过期（body 里 `status` 也会是 `expired`） |

`checks` 是服务端自动跑的「三项校验 + 发布」，宿主不用自己调飞书：

```json
{ "token": "ok", "read": "ok", "write": "ok", "publish": "ok", "details": "", "publish_details": "" }
```

**`app_secret` 默认是 `null`。** 主路径不要读它——Secret 由 Chrome 插件用配对码自取（见 4.3）。
只有兜底手动路径需要时，才带 `&reveal_secret=1` 取一次（取过之后不再返回，凭证也不会被销毁）。

### 4.3 配对（把凭证交给 Chrome 插件）

插件在用户浏览器里，没有 `host_token`，用户也不该手抄 Secret。流程：

```
插件「一键配置」显示 6 位配对码
→ 用户把码告诉宿主
→ 宿主 POST /api/setup/app/pair { session, code }   ← 只做绑定，不拿 Secret
→ 插件每 3 秒 GET /api/setup/app/pair?code=CODE      ← 命中后一次性取回凭证
```

`POST /api/setup/app/pair`（需 `host_token`）：`{ "session": "...", "code": "123456" }` → `{ "paired": true }`

服务端会从这次请求的 `Authorization` 里记下宿主的 `host_token`（只存内存），供插件取凭证时一并下发。

- 400：缺 `session` / 配对码不是 6 位数字 / 会话未完成 / 配对码已被占用
- 404：会话不存在；410：会话已过期

`GET /api/setup/app/pair?code=123456`（**无需鉴权**）→
`{ "app_id": "...", "app_secret": "...", "app_token": "...", "host_token": "..." }`

- **一次性**：返回后凭证与 `host_token` 立刻从服务端删除
- `host_token` 是宿主 POST 绑定时带上的那个；插件会把它自动写进设置，
  用户不需要再从 `~/.readloop/config.json` 手抄一遍（没有绑定时该字段为 `null`）
- 未绑定 / 码错 / 已过期 / 已取走 → 404（不区分具体原因）
- 同一配对码尝试超过 20 次 → 429

**宿主不要保存、不要输出 `app_secret`**：它属于插件，不属于 `~/.readloop/config.json`，也不该出现在对话里。

---

## 5. 数据通道说明

| 谁写表 | 用什么身份 |
|---|---|
| 宿主（日常读写 `knowledge_points` / `practice_events`） | 宿主自己的飞书能力（豆包原生 / `lark-cli`） |
| Chrome 插件（`capture_events`、新建知识点） | 用户自建飞书应用（第 4 节一键创建），插件直连 `open.feishu.cn` |

服务端**不访问用户表格、不保存任何用户数据**。

---

## 错误约定

| 状态码 | 含义 | 模型应该怎么做 |
|---|---|---|
| 400 | 参数缺失 / 格式错误 / 题目签名无效 | 检查请求体；题目报错就重新取题，提示用户 |
| 401 | host token 无效 | 让用户重新提供授权码激活 |
| **402** | **授权到期** | 告诉用户「年度授权已到期，续费后可继续」；**数据不动、不要重装** |
| 404 | setup 会话 / 配对码不存在 | 让用户重新发起「一键创建」或核对配对码 |
| 410 | setup 会话过期 | 让用户重新点一次验证链接 |
| 422 | `points` 为空或字段不全 | 回到读表步骤，检查字段名 |
| 429 | 配对尝试过多 | 让用户重新生成配对码 |
| 5xx | 服务异常 | 最多重试 2 次，如实告知，不要编题 |
