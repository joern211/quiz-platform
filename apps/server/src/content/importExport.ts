import type * as ExcelTypes from 'exceljs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ContentItemInputSchema, validateContentPayload } from '@quiz/shared';
import { ContentError, contentInputData, itemView, requirePool, validateTagIds, saveRevision, auditContent,
  changeItem, type ContentDb, type ContentActor } from './core.js';

const MAX_ROWS = 500, MAX_BYTES = 5 * 1024 * 1024;
// ExcelJS is CommonJS; use Node's loader consistently in production and in
// isolated VM tests (some transitive packages also load native ESM).
const Workbook = createRequire(import.meta.url)('exceljs/lib/doc/workbook.js') as typeof ExcelTypes.Workbook;
const columns = ['id', 'revision', 'title', 'prompt', 'question', 'answer', 'category', 'options', 'correctOptionId', 'explanation', 'points', 'wrongPoints', 'durationMs', 'value', 'language', 'difficulty', 'tags', 'source', 'sourceUrl', 'license'];
export type ImportRow = { externalId: string | null; input: z.infer<typeof ContentItemInputSchema>; tagNames: string[]; parseIssues: string[] };
export interface ImportPreviewRow { index: number; classification: 'NEW' | 'EXACT' | 'SIMILAR' | 'CONFLICT' | 'INVALID'; targetId: string | null; targetRevision: number | null; errors: string[]; unknownTags: string[]; title: string; proposed: unknown; current: unknown }
export function canonicalContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContent).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalContent(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const contentHash = (value: unknown) => createHash('sha256').update(canonicalContent(value)).digest('hex');
function checkXlsxExpansion(buffer: Buffer) {
  // Bound the ZIP's declared expanded size before ExcelJS allocates worksheets.
  // ZIP64/multi-disk/encrypted files are not supported for content import.
  let expanded = 0, entries = 0;
  for (let i = 0; i + 46 <= buffer.length; i++) if (buffer.readUInt32LE(i) === 0x02014b50) {
    if ((buffer.readUInt16LE(i + 8) & 1) || buffer.readUInt32LE(i + 24) === 0xffffffff) throw new ContentError('UNSUPPORTED_XLSX');
    expanded += buffer.readUInt32LE(i + 24); entries++;
    if (expanded > 32 * 1024 * 1024 || entries > 1000) throw new ContentError('IMPORT_TOO_LARGE', 413);
    i += 45 + buffer.readUInt16LE(i + 28) + buffer.readUInt16LE(i + 30) + buffer.readUInt16LE(i + 32);
  }
  if (!entries) throw new ContentError('INVALID_XLSX');
}
function safeCell(value: ExcelTypes.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') throw new ContentError('IMPORT_FORMULA_OR_COMPLEX_CELL');
  return String(value);
}
export async function parseContentImport(format: 'JSON' | 'CSV' | 'XLSX', data: Buffer, gameSlug: string): Promise<ImportRow[]> {
  if (data.length > MAX_BYTES) throw new ContentError('IMPORT_TOO_LARGE', 413);
  let rawRows: Array<Record<string, unknown>>;
  if (format === 'JSON') {
    let parsed: unknown; try { parsed = JSON.parse(data.toString('utf8')); } catch { throw new ContentError('INVALID_JSON_IMPORT'); }
    const envelope = z.object({ schemaVersion: z.literal(1), gameSlug: z.literal(gameSlug), items: z.array(z.record(z.unknown())).max(MAX_ROWS) }).passthrough().safeParse(parsed);
    if (!envelope.success) throw new ContentError('INVALID_IMPORT_VERSION_OR_GAME');
    rawRows = envelope.data.items;
  } else {
    const workbook = new Workbook();
    try {
      if (format === 'XLSX') { checkXlsxExpansion(data); await workbook.xlsx.load(Uint8Array.from(data).buffer); }
      else await workbook.csv.read(Readable.from(data.toString('utf8')), { parserOptions: { maxRows: MAX_ROWS + 2 } });
    } catch (error) { if (error instanceof ContentError) throw error; throw new ContentError('INVALID_TABULAR_IMPORT'); }
    const sheet = workbook.worksheets[0]; if (!sheet || sheet.rowCount > MAX_ROWS + 1) throw new ContentError('IMPORT_TOO_MANY_ROWS');
    const headers = sheet.getRow(1).values as ExcelTypes.CellValue[];
    const names = headers.slice(1).map(safeCell);
    if (new Set(names).size !== names.length || names.some(name => !columns.includes(name))) throw new ContentError('INVALID_IMPORT_COLUMNS');
    rawRows = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (let c = 1; c <= names.length; c++) {
        const value = safeCell(sheet.getRow(r).getCell(c).value);
        row[names[c - 1]] = format === 'CSV' && /^'[=+@\-\t\r']/.test(value) ? value.slice(1) : value;
      }
      if (Object.values(row).some(v => v !== '')) rawRows.push(row);
    }
  }
  if (!rawRows.length) throw new ContentError('IMPORT_EMPTY');
  return rawRows.map(raw => {
    const issues: string[] = [];
    const parseJsonField = (key: string, fallback: unknown): unknown => {
      try { return raw[key] === undefined || raw[key] === '' ? fallback : typeof raw[key] === 'string' ? JSON.parse(raw[key] as string) : raw[key]; }
      catch { issues.push(`${key}: ungültiges JSON`); return fallback; }
    };
    const number = (key: string, fallback: number) => raw[key] === undefined || raw[key] === '' ? fallback : Number(raw[key]);
    const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : gameSlug === 'wissensduell' ? {
      prompt: String(raw.prompt ?? ''), category: String(raw.category ?? ''), options: parseJsonField('options', []), correctOptionId: String(raw.correctOptionId ?? ''),
      explanation: String(raw.explanation ?? ''), points: number('points', 100), wrongPoints: number('wrongPoints', 0), durationMs: number('durationMs', 20000),
    } : { question: String(raw.question ?? ''), answer: String(raw.answer ?? ''), category: String(raw.category ?? ''), value: number('value', 100) };
    const candidates = { title: String(raw.title ?? ''), payload, language: raw.language || null, difficulty: raw.difficulty || null, tagIds: null,
      source: String(raw.source ?? ''), sourceUrl: String(raw.sourceUrl ?? ''), license: String(raw.license ?? '') };
    const parsed = ContentItemInputSchema.safeParse(candidates);
    if (!parsed.success) issues.push(...parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`));
    const input = parsed.success ? parsed.data : ContentItemInputSchema.parse({ title: String(raw.title ?? '').slice(0, 200), payload, source: '', sourceUrl: '', license: '' });
    const tags = parseJsonField('tags', []);
    if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string') || tags.length > 30) issues.push('tags: höchstens 30 Tag-Namen');
    return { externalId: typeof raw.id === 'string' && raw.id.length <= 128 ? raw.id : null, input,
      tagNames: Array.isArray(tags) ? [...new Set(tags.filter((t): t is string => typeof t === 'string').map(t => t.trim().toLocaleLowerCase()))].slice(0, 30) : [], parseIssues: issues };
  });
}
export async function previewContentImport(db: ContentDb, actor: ContentActor, poolId: string, rows: ImportRow[]) {
  const pool = await requirePool(db, poolId, actor, true);
  const existing = await db.contentItem.findMany({ where: { poolId } }), tags = await db.contentTag.findMany();
  const tagMap = new Map<string, string>(); for (const tag of tags) for (const name of [tag.slug, tag.name.toLocaleLowerCase(), ...JSON.parse(tag.aliasesJson)]) tagMap.set(name, tag.id);
  const normalize = (payload: unknown) => { const parsed = validateContentPayload(pool.gameSlug, payload); return parsed.success ? parsed.data : payload; };
  const previews: ImportPreviewRow[] = rows.map((row, index) => {
    const explicit = existing.find(item => item.id === row.externalId);
    const exact = existing.find(item => contentHash(normalize(JSON.parse(item.payloadJson))) === contentHash(normalize(row.input.payload)));
    const prompt = String(row.input.payload.prompt ?? row.input.payload.question ?? '').trim().toLocaleLowerCase();
    const similar = existing.find(item => { const p = JSON.parse(item.payloadJson); return prompt && String(p.prompt ?? p.question ?? '').trim().toLocaleLowerCase() === prompt; });
    const target = explicit ?? exact ?? similar;
    const validation = validateContentPayload(pool.gameSlug, row.input.payload);
    const errors = [...row.parseIssues, ...(validation.success ? [] : validation.error.issues.map(e => `${e.path.join('.')}: ${e.message}`))];
    const explicitExact = explicit && contentHash(normalize(JSON.parse(explicit.payloadJson))) === contentHash(normalize(row.input.payload));
    return { index, classification: errors.length ? 'INVALID' : explicit && !explicitExact ? 'CONFLICT' : exact ? 'EXACT' : similar ? 'SIMILAR' : 'NEW',
      targetId: target?.id ?? null, targetRevision: target?.revision ?? null, errors, unknownTags: row.tagNames.filter(name => !tagMap.has(name)), title: row.input.title,
      proposed: row.input, current: target ? itemView(target, pool) : null };
  });
  return { rows: previews, targetHash: contentHash({ revision: pool.revision, items: existing.map(i => [i.id, i.revision]).sort() }) };
}
export const ImportCommitSchema = z.object({ commandId: z.string().uuid(), importId: z.string().uuid(),
  decisions: z.array(z.object({ index: z.number().int().min(0).max(MAX_ROWS - 1), action: z.enum(['SKIP', 'IMPORT_NEW', 'UPDATE_EXISTING', 'IMPORT_DRAFT']) }).strict()).max(MAX_ROWS),
  tagDecisions: z.array(z.object({ name: z.string().max(80), action: z.enum(['CREATE', 'MAP', 'IGNORE']), targetId: z.string().optional() }).strict()).max(200),
}).strict();
export async function commitContentImport(db: ContentDb, actor: ContentActor, input: z.infer<typeof ImportCommitSchema>) {
  const draft = await db.contentImportDraft.findFirst({ where: { id: input.importId, actorId: actor.userId, expiresAt: { gt: new Date() }, consumedAt: null } });
  if (!draft) throw new ContentError('IMPORT_EXPIRED_OR_CONSUMED', 409);
  const rows = JSON.parse(draft.rowsJson) as ImportRow[];
  const fresh = await previewContentImport(db, actor, draft.poolId, rows);
  if (fresh.targetHash !== draft.targetHash) throw new ContentError('IMPORT_PREVIEW_STALE', 409);
  const expected = fresh.rows.filter(r => input.decisions.some(d => d.index === r.index && d.action !== 'SKIP')).flatMap(r => r.unknownTags);
  if (new Set(input.decisions.map(d => d.index)).size !== rows.length || input.decisions.length !== rows.length || input.decisions.some(d => d.index >= rows.length)) throw new ContentError('IMPORT_DECISION_REQUIRED');
  if (new Set(input.tagDecisions.map(t => t.name)).size !== input.tagDecisions.length) throw new ContentError('DUPLICATE_TAG_DECISION');
  const tags = await db.contentTag.findMany(), tagMap = new Map<string, string>();
  for (const tag of tags) for (const name of [tag.slug, tag.name.toLocaleLowerCase(), ...JSON.parse(tag.aliasesJson)]) tagMap.set(name, tag.id);
  for (const name of new Set(expected)) {
    const choice = input.tagDecisions.find(t => t.name === name); if (!choice) throw new ContentError('UNKNOWN_TAG_DECISION_REQUIRED');
    if (choice.action === 'IGNORE') continue;
    if (choice.action === 'MAP') { await validateTagIds(db, [choice.targetId ?? '']); tagMap.set(name, choice.targetId!); }
    else {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new ContentError('INVALID_TAG_SLUG');
      const tag = await db.contentTag.upsert({ where: { slug: name }, update: {}, create: { name, slug: name } }); tagMap.set(name, tag.id);
    }
  }
  const touched = new Set<string>(), results: Array<{ index: number; status: string; itemId?: string }> = [];
  for (const decision of input.decisions) {
    const row = rows[decision.index], preview = fresh.rows[decision.index];
    if (decision.action === 'SKIP') { results.push({ index: decision.index, status: 'SKIPPED' }); continue; }
    if (preview.errors.length && decision.action !== 'IMPORT_DRAFT') throw new ContentError('INVALID_ITEM_MUST_STAY_DRAFT');
    const itemInput = { ...row.input, tagIds: [...new Set(row.tagNames.map(name => tagMap.get(name)).filter((id): id is string => !!id))] };
    if (decision.action === 'UPDATE_EXISTING') {
      if (!preview.targetId || preview.targetRevision === null || touched.has(preview.targetId)) throw new ContentError('IMPORT_CONFLICT');
      touched.add(preview.targetId);
      await changeItem(db, actor, preview.targetId, preview.targetRevision, itemInput);
      results.push({ index: decision.index, status: 'UPDATED_DRAFT', itemId: preview.targetId });
    } else {
      const pool = await requirePool(db, draft.poolId, actor, true);
      const item = await db.contentItem.create({ data: { ...contentInputData(itemInput), poolId: pool.id, gameSlug: pool.gameSlug } });
      await saveRevision(db, item, actor, 'IMPORT', Object.keys(itemInput)); results.push({ index: decision.index, status: 'IMPORTED_DRAFT', itemId: item.id });
    }
  }
  await db.contentImportDraft.update({ where: { id: draft.id }, data: { consumedAt: new Date() } });
  await auditContent(db, actor, 'CONTENT_IMPORT', draft.poolId, { importId: draft.id, results });
  await db.contentNotification.create({ data: { userId: actor.userId, poolId: draft.poolId, kind: 'IMPORT_RESULT', message: `${results.filter(r => r.status !== 'SKIPPED').length} Inhalte als Entwurf importiert oder aktualisiert.` } });
  return { results };
}
export async function exportContent(db: ContentDb, actor: ContentActor, poolId: string, format: 'JSON' | 'CSV' | 'XLSX') {
  const pool = await requirePool(db, poolId, actor), items = await db.contentItem.findMany({ where: { poolId,
    status: ['PUBLIC', 'SYSTEM'].includes(pool.scope) && actor.role !== 'ADMIN' && pool.ownerId !== actor.userId ? 'READY' : { not: 'TRASHED' } }, orderBy: { id: 'asc' } });
  const tags = await db.contentTag.findMany();
  const rows = items.map(item => {
    const v = itemView(item, pool); return { id: v.id, revision: v.revision, title: v.title, payload: v.payload,
      language: v.effective.language, difficulty: v.effective.difficulty, tags: v.effective.tagIds.map(id => tags.find(t => t.id === id)?.slug).filter(Boolean),
      source: v.source, sourceUrl: v.sourceUrl, license: v.license };
  });
  if (format === 'JSON') return Buffer.from(JSON.stringify({ schemaVersion: 1, gameSlug: pool.gameSlug, pool: { name: pool.name, defaults: JSON.parse(pool.defaultsJson) }, items: rows }, null, 2));
  const workbook = new Workbook(), sheet = workbook.addWorksheet('Content');
  sheet.addRow(columns);
  for (const row of rows) {
    const flat: Record<string, unknown> = { ...row, ...row.payload, options: row.payload.options ? JSON.stringify(row.payload.options) : '', tags: JSON.stringify(row.tags) };
    sheet.addRow(columns.map(key => flat[key] ?? ''));
  }
  sheet.getRow(1).font = { bold: true }; sheet.columns.forEach(c => { c.width = 24; }); sheet.views = [{ state: 'frozen', ySplit: 1 }];
  // CSV cells starting with spreadsheet formula markers are quoted by an
  // explicit apostrophe. No user-provided cell ever becomes an Excel formula.
  if (format === 'CSV') {
    sheet.eachRow((row, i) => { if (i > 1) row.eachCell(cell => { if (typeof cell.value === 'string' && /^[=+@\-\t\r']/.test(cell.value)) cell.value = `'${cell.value}`; }); });
    return Buffer.from(await workbook.csv.writeBuffer());
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
