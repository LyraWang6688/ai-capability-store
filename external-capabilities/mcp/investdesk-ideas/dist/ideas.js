import { createRecord, getRecord, listRecords, textOf, updateRecord, } from './feishu.js';
/** 关联字段值 → record_id 数组（兼容 {record_ids:[]} / {id} / 原始 id） */
function extractIds(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => {
        if (typeof item === 'string')
            return item;
        if (item && typeof item === 'object') {
            const record = item;
            if (Array.isArray(record.record_ids))
                return String(record.record_ids[0] ?? '');
            if (record.id)
                return String(record.id);
        }
        return '';
    })
        .filter(Boolean);
}
async function findByCode(code) {
    const filter = {
        conjunction: 'and',
        conditions: [{ field_name: '代码', operator: 'is', value: [code] }],
    };
    const records = await listRecords({ pageSize: 5, filter, table: 'watch' });
    return records[0] ?? null;
}
/**
 * 记录一次推荐：
 *   1. 每个标的在备选池 upsert（已有则提及次数+1、更新最近提及、追加理由）
 *   2. 建一条灵感记录（问题 + 回复 + 推荐标的关联）
 *   3. 把灵感记录反向关联到每个标的
 */
export async function saveRecommendation(input) {
    const now = Date.now();
    const watchIds = [];
    const lines = [];
    for (const ins of input.instruments ?? []) {
        const code = String(ins.code ?? '').trim();
        if (!code)
            continue;
        const existing = await findByCode(code);
        if (existing) {
            const count = Number(existing.提及次数 ?? 0) + 1;
            const reasons = [textOf(existing.推荐理由), ins.reason].filter(Boolean).join('\n');
            await updateRecord(String(existing.record_id ?? ''), { 提及次数: count, 最近提及: now, 推荐理由: reasons || undefined }, 'watch');
            watchIds.push(String(existing.record_id ?? ''));
            lines.push(`${code} ${ins.name ?? textOf(existing.名称)}（第 ${count} 次）`);
        }
        else {
            const id = await createRecord({
                代码: code,
                名称: ins.name ?? '',
                资产类型: ins.type ?? '其他',
                提及次数: 1,
                首次提及: now,
                最近提及: now,
                状态: '观察中',
                推荐理由: ins.reason ?? '',
            }, 'watch');
            watchIds.push(id);
            lines.push(`${code} ${ins.name ?? ''}（首次）`);
        }
    }
    const ideaId = await createRecord({
        问题: input.question,
        时间: now,
        助手回复: input.answer ?? '',
        ...(input.topic ? { 话题: [input.topic] } : {}),
        ...(watchIds.length > 0 ? { 推荐标的: watchIds } : {}),
    }, 'ideas');
    // 反向补关联：标的.关联灵感 += 本次灵感
    for (const id of watchIds) {
        const current = await getRecord(id, 'watch').catch(() => null);
        if (!current)
            continue;
        const linked = new Set([...extractIds(current.关联灵感), ideaId]);
        await updateRecord(id, { 关联灵感: [...linked] }, 'watch');
    }
    return watchIds.length > 0
        ? `已记录灵感 1 条，备选池更新 ${watchIds.length} 个标的：\n${lines.join('\n')}`
        : '已记录灵感 1 条（本次没有识别出具体标的）。';
}
export async function listWatchlist(input = {}) {
    const conditions = [];
    if (input.status)
        conditions.push({ field_name: '状态', operator: 'is', value: [input.status] });
    const filter = conditions.length
        ? { conjunction: 'and', conditions }
        : undefined;
    const records = (await listRecords({ pageSize: input.limit ?? 100, filter, table: 'watch' }))
        .sort((a, b) => Number(b.提及次数 ?? 0) - Number(a.提及次数 ?? 0));
    const keyword = input.keyword?.trim();
    const hit = keyword
        ? records.filter((r) => [textOf(r.代码), textOf(r.名称), textOf(r.推荐理由)].join(' ').includes(keyword))
        : records;
    if (hit.length === 0)
        return '备选池里没有符合条件的标的。';
    const rows = hit.slice(0, input.limit ?? 20).map((r) => {
        const times = Number(r.提及次数 ?? 0);
        const first = formatDate(r.首次提及);
        const last = formatDate(r.最近提及);
        const reason = textOf(r.推荐理由).split('\n').filter(Boolean).slice(-1)[0] ?? '';
        return `· ${textOf(r.代码)} ${textOf(r.名称)}｜提及 ${times} 次｜首次 ${first}｜最近 ${last}｜${textOf(r.状态)}${reason ? `\n  最近理由：${reason}` : ''}`;
    });
    return `备选池（${hit.length} 个标的，按提及次数排序）\n${rows.join('\n')}`;
}
export async function searchInspirations(input) {
    const keyword = (input.keyword ?? '').trim();
    if (!keyword)
        return '请提供搜索关键词。';
    const records = (await listRecords({ pageSize: 200, table: 'ideas' })).sort(byTimeDesc);
    const hit = records.filter((r) => [textOf(r.问题), textOf(r.助手回复), textOf(r.话题)].join(' ').includes(keyword));
    if (hit.length === 0)
        return `没有找到包含「${keyword}」的灵感记录。`;
    return hit
        .slice(0, input.limit ?? 10)
        .map((r) => `【${formatDate(r.时间)}】${textOf(r.问题)}\n${textOf(r.助手回复).slice(0, 200)}`)
        .join('\n---\n');
}
export async function updateWatchlist(input) {
    let recordId = input.recordId;
    if (!recordId && input.code) {
        const found = await findByCode(input.code);
        recordId = found ? String(found.record_id ?? '') : undefined;
    }
    if (!recordId)
        return '找不到该标的。';
    if (!input.status)
        return '没有要更新的内容。';
    await updateRecord(recordId, { 状态: input.status }, 'watch');
    return `已把 ${input.code ?? recordId} 的状态改为「${input.status}」`;
}
/** 飞书读回来的日期是 ISO 字符串（写入时是毫秒数），两种都要能解析 */
function toMillis(value) {
    if (value == null || value === '')
        return 0;
    if (typeof value === 'number')
        return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
}
function formatDate(value) {
    const ms = toMillis(value);
    if (!ms)
        return '-';
    return new Date(ms).toISOString().slice(0, 10);
}
function byTimeDesc(a, b) {
    return toMillis(b.时间) - toMillis(a.时间);
}
