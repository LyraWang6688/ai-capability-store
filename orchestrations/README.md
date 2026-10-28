# Orchestration Domain

**一次任务，按什么顺序、用哪些东西。** 它只引用其它域，不复制任何实现。

## What belongs here

| Belongs here | Does NOT belong here |
|---|---|
| 一个任务分几步、每步用哪个域里的哪个资产 | 怎么做那一步（→ `skills/`）|
| 步骤之间的先后依赖 | 那一步的实现代码（→ `external-capabilities/`）|
| 步骤之间的**衔接规则**（"改一个必须看另一个"）| 什么时候触发（→ `automations/`）|

## 和另外三个域的关系

```text
skills/                 —— 怎么做
external-capabilities/  —— 能调什么
automations/            —— 什么时候跑
orchestrations/         —— 按什么顺序连（这一次任务）
```

一个编排可以**被** automation 定时触发；编排自己不当时钟。

## 布局：两层

```text
orchestrations/
  registry.yaml                 ← 唯一机器真相（验证器查这个）
  SELF-API.md                   ← 调自建 API 的编排怎么标
  <项目>/<任务>/
    README.md                   ← 人读：这条流程 + 衔接规则
    <link>  →  ../../../里的资产  ← 软链，给人看的那一份
```

| 层 | 回答什么 |
|---|---|
| **项目** | 这个任务属于哪个产品/项目。人找东西是按这个找的（"投资台那些""公众号那些"）|
| **任务** | 具体那一条。**谁发起它**写在记录的 `trigger` 字段里，不是目录层级 |

**项目下唯一允许的非任务目录是 `manuals/`**（操作手册区）：它不登记 registry、不进 tag，
只要求自带 README 说明自己。校验器按名字放行（`ORCHESTRATION_DOC_DIRS`），
和在 `automations/` 时代对 `computer-automation/` 的豁免同一个道理 —— 手册不是任务，
一份手册没有 `trigger`、没有 `output`。当前只有 `computer-automation/manuals/`。

**为什么不按"人发起 / 钟发起"分目录：** 那是任务的一个属性，不是它所在的位置 ——
和 `skills/` 一样，分类是注册表状态，不是目录结构。按模式分会把同一个项目的任务劈到
两棵树上，而人要的恰恰是"这个项目有哪些任务"。

`trigger` 取值：`human`（人说一句才做）· `host-schedule`（宿主自己的定时器）·
`daily` / `weekly` / `monthly` / `quarterly` · `event`。
自动不等于定时：事件（比如"本周第一次开机"）也是自动的一种。

**项目名不是封闭集合**：新增一个项目是一次正常的产品动作，不该变成一次 policy 决策。
任务名则必须精确等于目录名（`tag` 是 `<资产名>-v<版本>`，改名会让 tag 变孤儿）。

### 软链退几级

从任务目录到仓库根是 **3 层**（任务 → 项目 → orchestrations → 根），所以是
`../../../skills/...`。少退一级 = 断链，而验证器会抓住它。

**软链和 `registry.yaml` 的 `steps` 是同一份事实的两个视图。** 验证器保证两者一致。

### 调自建 API 的编排：任务名带 `-self-api`

这一类编排有**一段执行没有资产承载**：不是 MCP、不是 CLI、不是插件，而是 skill
正文里的一次 HTTP 调用，打到一个我们自己维护的后端服务上。能不能跑，取决于宿主的
执行与出网能力。

标记写在**两处，必须同时存在**：

```text
① 任务目录名以 -self-api 结尾      （文件命名上就能看出来）
② step 里写 calls:                 （服务名 + 契约 + 端点）
```

```text
✓ teaming-meeting-review-self-api  —— 目录名 + calls 都在
✗ teaming-meeting-review           —— 名字没标，验证器不准
✗ xxx-self-api 但没有 calls        —— 名字说调了，步骤里没写
```

判据三条，缺一不算：**endpoint 写在 skill 里** + **后面是自建后端** + **契约在 skill 的 `references/` 里**。
细节和"不算"的例子见 [`SELF-API.md`](./SELF-API.md)。

## steps 的形状

```yaml
steps:
  - id: write                          # 必填，本编排内唯一
    link: 1-write                      # 必填，目录里那个软链的文件名
    use: skills/geo-content            # 必填，必须等于某个已登记资产的路径
    produces: 正文 Markdown             # 可选，人读
  - id: layout
    link: 2-layout
    use: skills/wechat-html-css-layout
    needs: [write]                     # 可选，指向同编排里的其它 id
    produces: body HTML
```

调自建 API 的步骤多一个 `calls`，整条编排多两段：

```yaml
trigger: host-schedule                 # 可选：human / host-schedule / daily / weekly / monthly / event
execution:
  requires: [bash, curl, network, feishu-native]   # 宿主得会什么
  egress: [readinsight.bamamei.online]             # SOP 里显式指定的出网目的地
steps:
  - id: coach
    link: 1-coach
    use: skills/readloop
    calls:
      service: readloop-service                     # 必须是 hosting: external 的能力
      contract: skills/readloop/references/api.md   # 必须与服务记录里那份是同一个文件
      endpoints: [POST /api/review/today]
```

**这几个字段各自防一种"安静地坏掉"：**

| 字段 | 不写会怎样 |
|---|---|
| `trigger` | 看不出它靠什么被叫醒——是钟，还是事件 |
| `execution.requires` | 换一个没有 bash / curl 的宿主，链第一步就断，而编排层看不出来 |
| `execution.egress` | 数据出到哪里没有声明；服务换域名也没人会发现 |
| `calls` | 接口调用只活在 skill 正文里，店里不知道它对应哪个后端服务 |

`calls` 不是 `use`：店外服务没有 `implementation_path`，不是可引用的落地资产；
它是这一步的**运行时依赖**。反过来，店里的能力（有落地路径）只能用 `use` 引用，
不能写成 `calls` —— 否则同一个调用会有两个说法。

**验证器对每条编排查六件事：**

1. `use` 指向的路径**真的注册过**（Skill 的 path 或 Capability 的 implementation_path）
2. 软链 `<orch>/<link>` **存在且不是断链**
3. 软链的目标**等于** `use`
4. `needs` 指向的 `id` 存在
5. 没有环
6. 没有孤儿步骤（每个步骤都能从第一步走到）

**带 `calls` 的再查五件事：**

1. 目录名 `-self-api` 与 `calls` **必须一致**（有 calls 就必须带后缀，反之亦然）
2. `execution.requires` 是合法能力项，且**必须含 `network`**
3. `execution.egress` 是非空的域名列表
4. `calls.service` 已登记且 `hosting: external`
5. `calls.contract` 存在，且与该能力记录的 `contract_path` 相同；服务端点域名必须出现在 `egress` 里

## 加一个编排

1. 选模式 + 生态：`orchestrations/<模式>/<生态>/<任务>/`
2. 写 `README.md`（流程 + 衔接规则）
3. 建软链，每个指向一个已登记资产（Skill 的 path / Capability 的 implementation_path /
   Automation 的 path）
4. 调自建 API 的另两步：任务目录名加 `-self-api`；先在外部能力域登记店外服务
   （`hosting: external` + endpoint + 契约），再在编排里写 `execution` / `calls`
5. 在 `orchestrations/registry.yaml` 登记，`steps` 和软链一一对应
6. 跑 `python3 scripts/validate_store.py`

**任务名不能和它引用的资产重名** —— 否则 tag 也会重名
（`investdesk-quote-sync` 是 automation 的名字，所以那条编排叫 `investdesk-daily-report`）。

---

## 两种触发方式的通用流程

| 模式 | 抽象 |
|---|---|
| `automated` | **三段**：输入（钟或事件）→ 处理 → 输出（必须是 GUI）<br>段间：**能直连就直连，不能直连才插桥** |
| `manual` | 没有钟：人触发 → 调几个资产 → 交付 |

见 [`MANUAL.md`](./MANUAL.md)（人发起）与 [`AUTOMATED.md`](./AUTOMATED.md)（钟或事件发起）。

**调自建 API 不是第三个模式** —— manual 和 automated 里都可能有；标志是
**任务名带 `-self-api` + step 里有 `calls`**，不是它被谁发起。

**「几步」不是设计出来的** —— 是环境的产物：能直连的地方不占步数，不能直连的地方才多一个桥。
