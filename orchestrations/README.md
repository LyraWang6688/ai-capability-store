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

## 布局

```text
orchestrations/
  registry.yaml            ← 唯一机器真相（验证器查这个）
  <kebab-name>/
    README.md              ← 人读：流程 + 衔接规则
    <link>  →  ../.. 里的资产       ← 软链，给人看的那一份
```

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

1. 建 `orchestrations/<kebab-name>/`
2. 写 `README.md`（流程 + 衔接规则）
3. 建软链，每个指向一个已登记资产
4. 在 `orchestrations/registry.yaml` 登记，`steps` 和软链一一对应
5. 跑 `python3 scripts/validate_store.py`
