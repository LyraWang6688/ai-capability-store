# 接口契约

服务只做计算，**不存储用户数据**。表格读写全部由宿主用自己的飞书能力完成。

服务地址记为 `BASE`。除 `activate` 外，所有请求带 `Authorization: Bearer <host_token>`。

---

## POST /api/license/activate

用购买时拿到的 8 位授权码换 `host_token`。**这是所有其他接口的前提。**

**MVP 不限制激活次数**：同一个授权码可以在多台机器上重复激活，每次返回一个新的 `host_token`，旧 token 不强制失效。服务端只记录激活时间，用于换机排查。

请求：

```json
{ "license": "ABCD2345" }
```

返回：

```json
{ "hostToken": "...", "expiresAt": "2027-10-23T00:00:00+08:00" }
```

**授权按年计，`expiresAt` 是硬期限。** 到期后 token 失效，所有接口返回 402，用户需续费重新激活。

| 状态码 | 含义 |
|---|---|
| 401 | 授权码无效或已被撤销 |
| 5xx | 服务不可用 |

---

## POST /api/review/today

由宿主把候选知识点和**用户的模型配置**一起传给服务，服务选出今日题目并用该模型生成题面。

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

返回：

```json
{
  "date": "2026-10-23",
  "variant": 3,
  "total": 8,
  "questions": [
    {
      "question_id": "eyJhbGciOi...",
      "type": "choice",
      "stem": "The percentage of students ____ abroad is increasing.",
      "options": ["study", "studying", "studied"],
      "context": "原句上下文",
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

**`question_id` 是服务端签名的不透明串**，内含知识点与正确答案，客户端不要解析、不要修改、不要缓存到表格。题目对象本身**不含正确答案**。

选题是确定性的：同样的输入与日期，选出同一批知识点（题面措辞在重试时可能略有差异）。

---

## POST /api/review/submit

提交一题。服务从 `question_id` 解出答案与知识点，返回判分结果与状态更新。

请求：

```json
{
  "date": "2026-10-23",
  "question_id": "eyJhbGciOi...",
  "answer": "B",
  "used_hint": false,
  "elapsed_ms": 9000
}
```

返回：

```json
{
  "result": "correct",
  "explanation": "……",
  "updates": {
    "归一化内容": "subsequent",
    "状态": "review",
    "间隔天数": 6,
    "连对次数": 2,
    "答错次数": 0,
    "待练次数": 1,
    "下次复习": "2026-10-29"
  }
}
```

**宿主必须原样把 `updates` 写回表格，不要自己重算。**

---

## 错误约定

| 状态码 | 含义 | 模型应该怎么做 |
|---|---|---|
| 400 | 参数缺失或格式错误 | 检查请求体，提示用户 |
| 401 | host token 无效 | 让用户重新提供授权码 |
| **402** | **授权到期** | 告诉用户「年度授权已到期，续费后可继续」；**数据不动、不要重装** |
| 422 | `points` 为空或字段不全 | 回到读表步骤，检查字段名 |
| 5xx | 服务异常 | 最多重试 2 次，如实告知，不要编题 |
