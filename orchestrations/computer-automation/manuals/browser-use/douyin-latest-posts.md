# 抖音作品列表与「喜欢」列表抓取（含发布时间、作者、配乐）

> 环境：macOS / DSH 桌面端 / chrome-devtools MCP / Chrome 已登录 douyin.com
> 实测日期：2026-11-12
> 验证方式：拦截 `aweme/v1/web/aweme/post/`（他人主页作品）与 `aweme/v1/web/aweme/favorite/`（本人「喜欢」页）响应并解析，标题/顺序/点赞数与页面逐条比对；单条视频的配乐取自 `aweme/v1/web/aweme/detail/` 响应的 `music.title`，并与视频页作者、正文「发布时间：」核对一致
> 结论：已验证 —— 一次导航即可拿到某创作者最近约 20 条作品、或本人「喜欢」列表一页作品的 ID、标题、作者、精确到秒的发布时间、点赞数、配乐名

## 入口

chrome-devtools MCP（宿主已注册，stdio），只用到三个工具：`new_page` / `navigate_page` / `evaluate_script`。
关键参数是 `navigate_page` 的 `initScript`：它在文档加载前注入。用它包一层 `window.fetch` 与
`XMLHttpRequest.prototype.send`，把命中目标接口的响应文本塞进 `window.__CAP`。

三个目标接口，同一套脚本改一个字符串即可：

| 目标 | 拦截关键字 | 拿到的数据 |
|---|---|---|
| 他人主页作品 | `aweme/post` | 该创作者最近约 20 条作品 |
| 本人「喜欢」列表 | `aweme/favorite` | 本人点过赞的作品，一页若干条 |
| 单条视频详情 | `aweme/detail` | 标题、作者、配乐、时长、互动数 |

不要试图自己拼这些接口的 URL —— 它们带 `a_bogus` 签名，必须由页面自身发起。

## 浏览器会话

复用操作者已登录的 Chrome（MCP 连的是他默认 profile 的那个实例），所以**会碰到真实账号数据**。
公开主页的作品列表、点赞数本身不涉及私密信息，但写进文档时一律不记昵称、抖音号、`sec_uid`。
「喜欢」列表更进一步：它**只对本人可见**，读它等于读操作者的私域数据——只按他明确的要求取，不落盘、不外传。
另一个代价：登录态会随操作者切换账号而变，操作前先确认当前是谁的号（页面右上角有没有「登录」按钮）。

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| `new_page` / `navigate_page` | MCP | 打开主页或视频页；`navigate_page` 支持 `initScript` | Chrome 已启动且 MCP 已连上 |
| `evaluate_script` | MCP | 读 `window.__CAP`、解析 JSON、按作者过滤 | 同页执行，无跨域问题 |
| `take_screenshot` | MCP | 肉眼确认没被登录墙 / 验证码挡住 | 同上 |

## 可复现步骤

1. **拿 `sec_uid`**：`new_page` 打开 `https://www.douyin.com/search/<名字>`（结果页切到「用户」tab），
   `evaluate_script` 取所有 `a[href*="/user/MS4"]` 的 href。
   观察点：结果里同一个名字会出现多个账号，挑粉丝量级/认证对得上的那个，href 形如 `/user/MS4wLjABAAAA...`。
2. **带拦截脚本打开主页**：`navigate_page` 指向 `https://www.douyin.com/user/<sec_uid>`，
   `initScript` 注入：

   ```js
   (() => { window.__CAP = [];
     const push = (u, t) => { if (u && u.indexOf('aweme/post') > -1 && t) window.__CAP.push(t); };
     const of = window.fetch;
     window.fetch = (...a) => of(...a).then(r => {
       const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url);
       if (u && u.indexOf('aweme/post') > -1) r.clone().text().then(t => push(u, t)).catch(()=>{});
       return r; });
     const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
     XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return oo.call(this, m, u, ...r); };
     XMLHttpRequest.prototype.send = function (...a) {
       this.addEventListener('load', function () { push(this.__u, this.responseText); });
       return os.apply(this, a); };
   })();
   ```

   观察点：等 3～4 秒后 `window.__CAP.length` ≥ 1；标签页标题应变成「<昵称>的抖音」。
3. **解析**：`JSON.parse(__CAP[i])` → `aweme_list[]`，取
   `aweme_id` / `desc` / `create_time` / `statistics.digg_count`。
   `create_time` 是秒级时间戳，用 `Asia/Shanghai` 格式化。
   观察点：条数通常 20 条/批；按 `create_time` 倒序后，第一条 ≠ 主页第一格（主页第一格是置顶）。
4. **按作者过滤**（必做）：主页会并发请求「相关/推荐用户」的 `aweme/post`，同一批 `__CAP` 里混着别人的作品。
   用 `it.author.sec_uid`（或 `author.nickname`）只留目标创作者，否则会把别人的视频算到他头上。
5. **收尾**：要单条视频链接就拼 `https://www.douyin.com/video/<aweme_id>`；
   核对某条的时间/文案可直接打开该页，正文里有「发布时间：YYYY-MM-DD HH:MM」；最后关掉多余标签页。
6. **读本人「喜欢」列表**：`navigate_page` 打开 `https://www.douyin.com/user/self`（自己主页，切到「喜欢」tab），
   `initScript` 同上，只把 `aweme/post` 换成 `aweme/favorite`。
   观察点：3 秒后 `__CAP.length` ≥ 1，`aweme_list` 字段与第 3 步同构（多一个 `music`）。
   一页只返回若干条，要更多就滚到底部触发下一页（同样会被拦到）；做增量时用两次运行的 `aweme_id` 差集。
7. **取配乐名**：视频页**不渲染**配乐字段，只能拦 `aweme/detail`——
   `navigate_page` 打开 `https://www.douyin.com/video/<aweme_id>`，`initScript` 匹配 `aweme/detail`。
   观察点：`aweme_list[0].music.title` 形如「@某人创作的原声」；`music.author` / `music.owner_handle`
   给出原声归属，用来判断这条是「造原声」还是「跟别人的原声」。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| `fetch('/video/<id>')` 拿到的 HTML 里搜 `create_time` 是 null | 视频页是 SPA，作品数据不在首屏 HTML 里 | 用第 2 步的响应拦截；或直接打开详情页读正文「发布时间」 |
| 解析出来的列表混着好几个账号的作品 | 主页并发请求了推荐账号的 `aweme/post` | 先按 `author.sec_uid` 过滤，再排序 |
| 解析出来的顺序和主页格子对不上 | 主页有置顶 | 以 `create_time` 排序；置顶只影响展示位置 |
| 页面显示「未登录」，主页只剩推荐流 | 操作者切了账号 / 登录态过期 | 让操作者扫二维码登录后再继续；不要用别人的登录态替代 |
| 主页作品列表滚到底只有 20 条 | 首批接口只返回一页 | 要更多就滚动列表触发 `max_cursor` 翻页（同样会被拦到），或只取最新 20 条 |
| 视频页找不到配乐名，DOM 里也没有 music 节点 | Web 视频页根本不渲染 `music` 字段 | 走第 7 步拦截 `aweme/detail`，取 `music.title` |
| `music.is_original` 一直是 false，看不出是不是本人原声 | 该字段不反映「是否本人原声」 | 用 `music.author` 是否等于 `author.nickname` 判断；相等=本人原声，不等=跟别人的原声 |
| 打开「喜欢」页看到的是推荐流 | 「喜欢」只对本人可见，登录态不是本人的 | 先确认当前登录账号就是数据主人 |

## 何时别用

- **只要一两天的更新**：不拦截、直接打开 `/user/<sec_uid>` 看前三格 + 打开详情页读时间，更快。
- **跨多个账号、要定时监控**：别用浏览器。走抖音开放平台（数据开放服务），稳定性、频率、合规都更好；
  浏览器方案适合「临时看几个人最近发了什么」。
- **要「我点赞过的视频」做成对外服务 / 多账号 / 合规数据源**：官方**没有**这个能力。
  移动/网站应用的 OpenAPI 只有「本人发布的视频」与粉丝/关注类数据；「视频数据」能力也是在**用户授权**下
  查他自己发布的视频（需申请「内容运营-视频信息数据」「内容运营-视频互动数据」，审核 2-3 个工作日）。
  所以这条路只能在本机浏览器做增量，不能拿来对外供数。
- **要历史全量 / 做数据集**：这条路的翻页依赖页面滚动，慢且易断，不适合。
- **只读公开内容、不登录**：用 `web_fetch` 或搜索页即可，不必驱动浏览器。
