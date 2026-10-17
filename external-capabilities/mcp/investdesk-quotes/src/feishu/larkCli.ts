/**
 * lark-cli 后端 —— 复用本机已登录的 lark-cli。
 *
 * 优点：零配置，凭证在 lark-cli 自己的凭据库里，项目里不存任何 secret。
 * 限制：只能在本机跑，云端没有 keychain 拿不到用户令牌。
 *
 * 注意：lark-cli 的 --output / @file 只接受相对路径，所以所有命令的 cwd
 * 固定为工作目录 WORK_DIR，产物也落在 WORK_DIR/.cache 下。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BASE_TOKEN, CACHE_DIR, LARK_CLI, WORK_DIR, assertFeishuConfigured } from '../config.ts';
import type { FeishuBackend, RawRecord } from './backend.ts';

const execFileAsync = promisify(execFile);

interface LarkEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { message?: string; code?: number };
}

export class LarkCliBackend implements FeishuBackend {
  readonly name = 'lark-cli';

  private async run(args: string[]): Promise<string> {
    assertFeishuConfigured();
    try {
      const { stdout } = await execFileAsync(LARK_CLI, args, {
        cwd: WORK_DIR,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env },
      });
      return stdout;
    } catch (error) {
      const err = error as { stderr?: string; stdout?: string; message?: string };
      const detail = (err.stderr || err.stdout || err.message || '').slice(0, 800);
      throw new Error(`lark-cli 执行失败：${detail}`);
    }
  }

  private static parseEnvelope<T>(stdout: string): T {
    const envelope = JSON.parse(stdout) as LarkEnvelope<T>;
    if (!envelope.ok) {
      throw new Error(`飞书接口返回失败：${envelope.error?.message ?? 'unknown'}`);
    }
    return envelope.data as T;
  }

  async listRecords(tableId: string, limit: number): Promise<RawRecord[]> {
    await mkdir(CACHE_DIR, { recursive: true });
    const relativeOut = `.cache/${tableId}.ndjson`;
    // --output 模式下 stdout 是 ndjson manifest（没有 ok 字段），
    // 真正的记录写在文件里；命令失败时 run 会抛错。
    await this.run([
      'base', '+record-list',
      '--base-token', BASE_TOKEN,
      '--table-id', tableId,
      '--limit', String(limit),
      '--format', 'ndjson',
      '--output', relativeOut,
      '--overwrite',
      '--as', 'user',
    ]);

    const ndjson = await readFile(path.join(WORK_DIR, relativeOut), 'utf8');
    return ndjson
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RawRecord);
  }

  async batchUpdateRecords(
    tableId: string,
    updates: Array<{ recordId: string; fields: Record<string, unknown> }>,
  ): Promise<number> {
    if (updates.length === 0) return 0;
    await mkdir(CACHE_DIR, { recursive: true });

    const CHUNK = 200;
    let written = 0;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const patch: Record<string, Record<string, unknown>> = {};
      for (const update of chunk) patch[update.recordId] = update.fields;

      const fileName = `.cache/patch-${Date.now()}-${i}.json`;
      const absolute = path.join(WORK_DIR, fileName);
      await writeFile(absolute, JSON.stringify({ update_records: patch }), 'utf8');
      try {
        const stdout = await this.run([
          'base', '+record-batch-update',
          '--base-token', BASE_TOKEN,
          '--table-id', tableId,
          '--json', `@./${fileName}`,
          '--as', 'user',
        ]);
        LarkCliBackend.parseEnvelope<{ record_id_list?: string[] }>(stdout);
        written += chunk.length;
      } finally {
        await rm(absolute, { force: true });
      }
    }
    return written;
  }
}
