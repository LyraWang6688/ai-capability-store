#!/usr/bin/env node
/**
 * DeepSeek 开放平台 · 月度自动开票
 *
 * 设计原则：
 *  - 默认 dry-run（只读金额，绝不提交）；提交必须显式 --live
 *  - 通过 CDP 复用你已登录的 Chrome（127.0.0.1:9222），不新建窗口
 *  - 金额为 0 → 跳过（幂等，避免重复开票）
 *  - 读不到金额 → 退出码 4（不猜 0，页面改版必须让人知道）
 *  - 提交后未验证到成功提示 → 退出码 5（人工核对，禁止自动重提）
 *  - 登录失效 → 退出码 2，上层可据此通知
 *  - 只用语义锚点（name/id/placeholder/文本），不用哈希类名
 *  - 每步截图 + 结构化日志
 *
 * 用法：
 *   node run.mjs --dry-run                 # 只读
 *   node run.mjs --live                    # 真提交（金额>0 时）
 *   node run.mjs --live --max-amount 2000  # 加金额上限保护
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, parseAvailableAmount } from './lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(ROOT, 'logs', `run-${runId}.log`);

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}
function emit(obj) {
  process.stdout.write('\n@@RESULT@@ ' + JSON.stringify(obj) + '\n');
}
function parseArgs(argv) {
  const a = { live: false, maxAmount: null, timeout: 60000, mode: null, storageState: null, executablePath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') a.live = true;
    else if (argv[i] === '--dry-run') a.live = false;
    else if (argv[i] === '--max-amount') a.maxAmount = Number(argv[++i]);
    else if (argv[i] === '--timeout') a.timeout = Number(argv[++i]) * 1000;
    else if (argv[i] === '--mode') a.mode = argv[++i];
    else if (argv[i] === '--storage-state') a.storageState = argv[++i];
    else if (argv[i] === '--executable-path') a.executablePath = argv[++i];
  }
  return a;
}
async function snap(page, name) {
  try {
    await page.screenshot({ path: path.join(ROOT, 'logs', `${name}-${runId}.png`) });
  } catch { /* 截图失败不影响主流程 */ }
}

/** 读「可开票金额」：取弹窗内形如 ¥ 123.45 的最内层文本节点 */
async function readAvailable(modal) {
  return await modal.evaluate((el) => {
    const nodes = [...el.querySelectorAll('.ds-text, span, div')];
    const hit = nodes.find(
      (n) => n.children.length === 0 && /^[¥￥]\s*[\d,.]+$/.test((n.textContent || '').trim())
    );
    return hit ? hit.textContent.trim() : null;
  });
}

/** 连接 Chrome：优先 wsUrl → DevToolsActivePort（Chrome 可能禁用 HTTP /json 发现端点）→ cdpUrl */
async function connectChrome() {
  if (cfg.wsUrl) {
    log('使用配置 wsUrl:', cfg.wsUrl);
    return chromium.connectOverCDP(cfg.wsUrl);
  }
  const portFile = cfg.devToolsActivePortFile
    ? cfg.devToolsActivePortFile.replace(/^~/, process.env.HOME || '')
    : null;
  if (portFile && fs.existsSync(portFile)) {
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    if (port && wsPath) {
      const ws = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
      log('使用 DevToolsActivePort →', ws);
      return chromium.connectOverCDP(ws);
    }
  }
  log('回退到 cdpUrl:', cfg.cdpUrl);
  return chromium.connectOverCDP(cfg.cdpUrl);
}

/**
 * 打开浏览器，两种模式：
 *  - cdp     ：连接已登录的本地 Chrome（开发/本地定时用）
 *  - browser ：自己启动 headless Chromium + 导入 storageState（服务器用）
 */
async function openBrowser(args) {
  const mode = args.mode || cfg.mode || 'cdp';
  log('浏览器模式:', mode);

  if (mode === 'browser') {
    const statePath = args.storageState || cfg.storageStatePath;
    if (!statePath || !fs.existsSync(statePath)) {
      throw new Error('browser 模式需要 storageState 文件: ' + (statePath || '(未配置)'));
    }
    const browser = await chromium.launch({
      headless: cfg.headless !== false,
      executablePath: args.executablePath || cfg.executablePath || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-timer-throttling'],
    });
    const ctx = await browser.newContext({
      storageState: statePath,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: cfg.userAgent || undefined,
    });
    const page = await ctx.newPage();
    log('已导入登录态:', statePath);
    return { browser, ctx, page };
  }

  const browser = await connectChrome();
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP 已连接，但找不到浏览器上下文');
  let page = ctx.pages().find((p) => p.url().includes('platform.deepseek.com'));
  if (!page) page = await ctx.newPage();
  log('使用页面:', page.url());
  return { browser, ctx, page };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log('=== start ===', 'mode=' + (args.live ? 'LIVE' : 'dry-run'), 'config:', cfg.transactionsUrl);

  const { browser, page } = await openBrowser(args);

  await page.goto(cfg.transactionsUrl, { waitUntil: 'domcontentloaded', timeout: args.timeout });
  await page.waitForTimeout(3000);
  await snap(page, '01-transactions');

  // 1) 登录态
  const body = await page.locator('body').innerText();
  if (!body.includes('发票管理')) {
    log('❌ 登录态失效');
    await snap(page, '01-auth-required');
    emit({ ok: false, code: 'AUTH_REQUIRED', message: 'DeepSeek 登录已失效，请重新登录后再执行' });
    await browser.close();
    process.exit(EXIT_CODES.AUTH_REQUIRED);
  }
  log('✅ 登录态正常');

  // 2) 打开发票管理弹窗
  const entry = page.getByRole('button', { name: '发票管理' });
  if (await entry.count()) await entry.first().click();
  else await page.getByText('发票管理', { exact: true }).first().click();
  await page.waitForSelector('.ds-modal', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await snap(page, '02-modal');

  const modal = page.locator('.ds-modal').first();

  // 3) 读可开票金额
  // 「读不到」和「读到 0」是两件事：前者是页面改版/未加载，后者才是本月已开完。
  // 以前两者都落到 0，于是页面一变就静默跳过一个月。
  const amountText = await readAvailable(modal);
  const amount = parseAvailableAmount(amountText);
  log('可开票金额:', String(amountText), '→', amount.kind, amount.value);

  if (amount.kind === 'unreadable') {
    log('❌ 读不到可开票金额（页面结构变化 / 金额未加载 / 匹配规则失效），未做任何开票操作');
    await snap(page, '03-amount-unreadable');
    await page.keyboard.press('Escape').catch(() => {});
    emit({
      ok: false,
      code: 'AMOUNT_UNREADABLE',
      raw: amountText,
      message: '读不到可开票金额，未提交。请查看截图并核对页面结构 / 金额匹配规则',
    });
    await browser.close();
    process.exitCode = EXIT_CODES.AMOUNT_UNREADABLE;
    return;
  }

  const available = amount.value;

  if (available <= 0) {
    log('本月无可开额度（明确读到 0），跳过');
    await page.keyboard.press('Escape').catch(() => {});
    emit({ ok: true, skipped: true, available: 0, message: 'DeepSeek 本月已开完或暂无额度' });
    await browser.close();
    return;
  }

  if (!args.live) {
    log('dry-run：有额度但不提交');
    await page.keyboard.press('Escape').catch(() => {});
    emit({ ok: true, dryRun: true, available, message: `可开票 ${available} 元（dry-run 未提交）` });
    await browser.close();
    return;
  }

  const limit = args.maxAmount ?? cfg.maxAmount;
  if (limit && available > limit) {
    log('❌ 金额超过上限', available, '>', limit);
    await page.keyboard.press('Escape').catch(() => {});
    emit({ ok: false, code: 'AMOUNT_EXCEEDED', available, limit });
    await browser.close();
    process.exit(EXIT_CODES.AMOUNT_EXCEEDED);
  }

  // 4) 开票方式：按充值金额开票
  await modal.locator('input[name="incomeType"][value="TOPUP"]').check({ force: true }).catch(async () => {
    await modal.getByText('按充值金额开票', { exact: true }).click();
  });
  await page.waitForTimeout(400);

  // 5) 开票金额
  await modal.locator('input[placeholder="请输入开票金额"]').fill(String(available));
  await page.waitForTimeout(300);

  // 6) 邮箱
  await modal.locator('input[placeholder="请输入邮箱"]').fill(cfg.email);
  await page.waitForTimeout(300);

  // 7) 抬头类型：企业
  await modal.locator('input[name="fapiaoTitleType"][value="BUSSINESS"]').check({ force: true }).catch(async () => {
    await modal.getByText('企业', { exact: true }).click();
  });
  await page.waitForTimeout(600);

  // 8) 开票类型：增值税普通发票
  await modal.locator('input[name="fapiaoType"][value="ORDINARY"]').check({ force: true }).catch(async () => {
    await modal.getByText('增值税普通发票', { exact: true }).click();
  });
  await page.waitForTimeout(600);
  await snap(page, '03-filled-basic');

  // 9) 发票抬头（自研自动补全：必须点下拉第一项，不能直接提交）
  const titleInput = modal.locator('input.ds-select__input').first();
  await titleInput.click();
  await titleInput.fill(cfg.invoiceTitle);
  await page.waitForTimeout(1200);
  const option = modal.getByText(cfg.invoiceTitle, { exact: true }).last();
  if (await option.count()) {
    await option.click();
    log('✅ 已从下拉选中抬头:', cfg.invoiceTitle);
  } else {
    log('⚠️ 未出现下拉选项，保留输入值');
    await titleInput.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(600);

  // 10) 纳税人识别号
  await modal.locator('input[placeholder="请输入纳税人识别号"]').fill(cfg.taxId);
  await page.waitForTimeout(400);
  await snap(page, '04-filled-all');

  // 11) 提交
  const submit = modal.getByRole('button', { name: '提交' });
  if (await submit.count()) await submit.first().click();
  else await modal.getByText('提交', { exact: true }).last().click();
  log('已点击提交，等待结果…');
  await page.waitForTimeout(4000);
  await snap(page, '05-after-submit');

  // 12) 校验结果
  const after = await page.locator('body').innerText();
  const successHints = ['申请成功', '提交成功', '开票中', '进行中', '已提交'];
  const ok = successHints.some((k) => after.includes(k));
  if (ok) {
    log('✅ 提交成功');
    emit({
      ok: true,
      submitted: true,
      available,
      title: cfg.invoiceTitle,
      taxId: cfg.taxId,
      email: cfg.email,
      invoiceType: cfg.invoiceType,
      message: `已提交开票申请：${available} 元，电子发票约 7 个工作日内发送至 ${cfg.email}`,
    });
  } else {
    log('❌ 未检测到成功提示，需人工核对（不要自动重提，避免重复申请）');
    emit({
      ok: false,
      code: 'SUBMIT_UNVERIFIED',
      available,
      message: '未检测到成功提示，请查看截图与页面状态。不要自动重提，先确认发票是否已提交',
    });
    // systemd 只看退出码：以前这里 return 掉、退出码 0，等于把"不知道"报成"成功"。
    process.exitCode = EXIT_CODES.SUBMIT_UNVERIFIED;
  }
  await browser.close();
}

main().catch(async (err) => {
  log('❌ 异常:', err?.message || String(err));
  emit({ ok: false, code: 'EXCEPTION', message: String(err?.message || err) });
  process.exit(EXIT_CODES.EXCEPTION);
});
