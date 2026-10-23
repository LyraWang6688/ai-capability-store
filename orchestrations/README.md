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

## 布局：三层

```text
orchestrations/
  registry.yaml                     ← 唯一机器真相（验证器查这个）
  <模式>/<生态>/<任务>/
    README.md                       ← 人读：流程 + 衔接规则
    <link>  →  ../../../里的资产      ← 软链，给人看的那一份
```

| 层 | 回答什么 | 现在有哪些 |
|---|---|---|
| **模式** | 这一类任务**靠什么跑完** | `manual`（人说一句就做）· `scheduled-task`（钟来叫）· `service-call`（宿主调一个自建的后端服务）|
| **生态** | 它动用了**哪个平台**的资产 | `wechat` · `dsh` · `doubao-work` |
| **任务** | 具体那一条 | `wechat-article` · `investdesk-daily-report` · `teaming-meeting-review` · `readloop-daily` |

### 为什么第二级是「生态」而不是「谁执行」

```text
"谁执行"已经在 automations/registry.yaml 的 executor 字段里记过一次了
        ↓
再在编排里记一遍，就是两个真相
        ↓
而"动用了哪个平台的资产"是编排自己的事 —— 看 steps 里的 use: 就知道
```

`wechat-article` 放在 `manual/wechat/` 而不是某个 agent 下面，因为它的四步
（写 / 排版 / 动图 / 上传）没有一步是「只能在某个 agent 上跑」的。

**三个都是封闭集合**（`ORCHESTRATION_MODES` / `ORCHESTRATION_ECOSYSTEMS`），和货架、生态同一套纪律。

> 模式不描述"跑什么"，只描述"这一趟靠什么跑完"。对前两个模式，这等价于
> "怎么被发起"，所以第二层再分生态不会自相矛盾；`service-call` 打破了这层等价：
> 它可以是人问的，也可以是宿主定时任务叫醒的 —— 所以它必须另写 `trigger`。

### service-call：接口写在 SOP 里，服务在店外

这一类任务的共同点不是"跨机器"，而是：**有一段执行没有资产承载。**
不是 MCP、不是 CLI、不是插件，而是 skill 正文里的一次 HTTP 调用，打到一个我们
自己维护的后端服务上。能不能跑，取决于宿主的执行与出网能力。

```text
✓ 算这一类：endpoint 写在 skill 里 + 后面是自建后端 + 契约在 skill 的 references/ 里
✗ 不算：repo-collector 调 GitHub 公开 API（脚本承载、平台 API）
✗ 不算：beijing-theater-calendar / investdesk-research（skill 里零 endpoint，数据来自宿主搜索/插件）
```

### 三级路径的代价

软链要多退一级：从任务目录到仓库根是 **4 层**（任务 → 目标 → 模式 → orchestrations → 根），
所以是 `../../../../skills/...`。少退一级 = 断链，而验证器会抓住它。

**软链和 `registry.yaml` 的 `steps` 是同一份事实的两个视图。** 验证器保证两者一致。

> ⚠️ 为什么需要验证器管这个：**git 不会告诉你软链断了。** 实测——删掉目标之后
> `git status` 是干净的，而软链仍然指着不存在的地方。这是这个仓库最防的那种"安静地坏掉"。

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

`service-call` 的步骤多一个 `calls`（这一步的 SOP 会调一个店外服务），整条编排多两段：

```yaml
trigger: host-schedule                 # service-call 必填：human / host-schedule / daily / …
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
| `trigger` | 模式不回答这条链是不是定时的，「它每天 9 点跑」这个事实就没了 |
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

**`service-call` 再查五件事：**

1. `trigger` 已写且合法
2. `execution.requires` 是合法能力项，且**必须含 `network`**
3. `execution.egress` 是非空的域名列表
4. 至少一步有 `calls`；`calls.service` 已登记且 `hosting: external`
5. `calls.contract` 存在，且与该能力记录的 `contract_path` 相同；服务端点域名必须出现在 `egress` 里

## 加一个编排

1. 选模式 + 生态：`orchestrations/<模式>/<生态>/<任务>/`
2. 写 `README.md`（流程 + 衔接规则）
3. 建软链，每个指向一个已登记资产（Skill 的 path / Capability 的 implementation_path /
   Automation 的 path）
4. `service-call` 的另两步：先在该域登记店外服务（`hosting: external` + endpoint + 契约），
   再在编排里写 `trigger` / `execution` / `calls`
5. 在 `orchestrations/registry.yaml` 登记，`steps` 和软链一一对应
6. 跑 `python3 scripts/validate_store.py`

**任务名不能和它引用的资产重名** —— 否则 tag 也会重名
（`investdesk-quote-sync` 是 automation 的名字，所以那条编排叫 `investdesk-daily-report`）。

---

## 三个模式各自的通用流程

| 模式 | 抽象 |
|---|---|
| `scheduled-task/` | **三段**：输入（钟）→ 处理 → 输出（必须是 GUI）<br>段间：**能直连就直连，不能直连才插桥** |
| `manual/` | 没有钟：人触发 → 调几个资产 → 交付 |
| `service-call/` | **取数（宿主能力）→ 契约调用（宿主 shell + 店外服务）→ 落回（宿主能力 + GUI）**<br>前提：`execution.requires` 声明的宿主能力 |

见各自的 `README.md`。

**「几步」不是设计出来的** —— 是环境的产物：能直连的地方不占步数，不能直连的地方才多一个桥。
