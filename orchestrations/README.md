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
| **模式** | 这一类任务**是怎么被发起的** | `manual`（人说一句就做）· `scheduled-task`（钟来叫）|
| **生态** | 它动用了**哪个平台**的资产 | `wechat` · `dsh` · `doubao-work` |
| **任务** | 具体那一条 | `wechat-article` · `investdesk-daily-report` |

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

**两个都是封闭集合**（`ORCHESTRATION_MODES` / `ORCHESTRATION_ECOSYSTEMS`），和货架、生态同一套纪律。

> 模式不描述"跑什么"，只描述"怎么被发起"。所以它不叫 `scheduled-dsh-task` ——
> 那样第二层再分 `dsh/` 和 `doubao-work/` 就自相矛盾了。

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

**验证器查六件事：**

1. `use` 指向的路径**真的注册过**（Skill 的 path 或 Capability 的 implementation_path）
2. 软链 `<orch>/<link>` **存在且不是断链**
3. 软链的目标**等于** `use`
4. `needs` 指向的 `id` 存在
5. 没有环
6. 没有孤儿步骤（每个步骤都能从第一步走到）

## 加一个编排

1. 选模式 + 生态：`orchestrations/<模式>/<生态>/<任务>/`
2. 写 `README.md`（流程 + 衔接规则）
3. 建软链，每个指向一个已登记资产（Skill 的 path / Capability 的 implementation_path /
   Automation 的 path）
4. 在 `orchestrations/registry.yaml` 登记，`steps` 和软链一一对应
5. 跑 `python3 scripts/validate_store.py`

**任务名不能和它引用的资产重名** —— 否则 tag 也会重名
（`investdesk-quote-sync` 是 automation 的名字，所以那条编排叫 `investdesk-daily-report`）。

---

## 两个模式各自的通用流程

| 模式 | 通用流程 |
|---|---|
| `scheduled-task/` | **五段**：① 敲钟 → ② 执行 → ③ 推事件 → ④ 消费 → ⑤ 执行 skill |
| `manual/` | 没有钟：人触发 → 调几个资产 → 交付 |

见各自的 `README.md`。

**五段是骨架，`steps` 是可校验的落点。** 一个 automation 可能把 ②③④ 全包在内部，
那时它们只能共享一个 `use:` —— 具体编排不必凑够五段。
