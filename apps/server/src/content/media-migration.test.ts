import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

it('upgrades real legacy media copies as new DRAFT revisions, preserving history, user edits and private asset authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quiz-legacy-content-media-'));
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA foreign_keys=ON');
      const dir = process.argv[2], names = readdirSync(dir).filter(n => /^20/.test(n)).sort();
      const apply = n => db.exec(readFileSync(join(dir, n, 'migration.sql'), 'utf8'));
      for (const name of names.filter(n => n < '20261025130000')) apply(name);
      for (const id of ['owner','other']) db.prepare('INSERT INTO users(id,displayName,passwordHash,role,updatedAt) VALUES(?,?,?,?,CURRENT_TIMESTAMP)').run(id,id,'unused','HOST');
      db.exec("INSERT INTO question_packs(id,gameSlug,title,createdBy,updatedAt) VALUES('pack','wissensduell','Legacy','owner',CURRENT_TIMESTAMP)");
      for (const id of ['owned-asset','foreign-asset']) db.prepare('INSERT INTO media_assets(id,type,mimeType,filename,originalName,fileSize,sha256,storagePath,uploadedBy,visibility,processStatus) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'image','image/webp',id,id,10,id,'/test/'+id,id==='owned-asset'?'owner':'other','PRIVATE','READY');
      const options = JSON.stringify([{id:'a',text:'A',label:'Legacy A'},{id:'b',text:'B'}]);
      for (const id of ['untouched','edited','foreign']) db.prepare('INSERT INTO geo_questions(id,packId,prompt,category,options,correctOptionId,mediaAssetId,mediaType,updatedAt) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(id,'pack','Legacy prompt','Test',options,'b',id==='foreign'?'foreign-asset':'owned-asset','image');
      for (const name of names.filter(n => n >= '20261025130000' && n < '20261025170000')) apply(name);
      const original = db.prepare("SELECT snapshotJson FROM content_revisions WHERE itemId='untouched' AND revision=1").get().snapshotJson;
      db.exec("UPDATE content_items SET payloadJson=json_set(payloadJson,'$.prompt','User edit'),revision=2 WHERE id='edited'");
      db.exec("INSERT INTO content_revisions(id,itemId,revision,kind,changedFieldsJson,snapshotJson) VALUES('edited-v2','edited',2,'EDIT','[]','{}')");
      for (const name of names.filter(n => n >= '20261025170000')) apply(name);
      const rows = db.prepare('SELECT id,status,revision,payloadJson FROM content_items ORDER BY id').all();
      const revisions = db.prepare("SELECT revision,kind,snapshotJson FROM content_revisions WHERE itemId='untouched' ORDER BY revision").all();
      const refs = db.prepare('SELECT itemId,assetId FROM content_media_references').all();
      let protectedAsset = false; try { db.exec("DELETE FROM media_assets WHERE id='owned-asset'"); } catch { protectedAsset=true; }
      const legacy = db.prepare("SELECT mediaAssetId,options FROM geo_questions WHERE id='untouched'").get();
      console.log(JSON.stringify({rows,revisions,refs,original,protectedAsset,legacy})); db.close();
    `, join(directory, 'test.db'), join(root, 'prisma/migrations')]);
    const result = JSON.parse(stdout);
    const untouched = result.rows.find((r: { id: string }) => r.id === 'untouched'), edited = result.rows.find((r: { id: string }) => r.id === 'edited');
    expect(untouched).toMatchObject({ status: 'DRAFT', revision: 2 });
    expect(JSON.parse(untouched.payloadJson)).toMatchObject({ mediaAssetId: 'owned-asset', mediaType: 'image', options: [{ id: 'a', text: 'A', label: 'Legacy A' }, { id: 'b', text: 'B' }] });
    expect(JSON.parse(edited.payloadJson).prompt).toBe('User edit'); expect(JSON.parse(edited.payloadJson).mediaAssetId).toBeUndefined();
    expect(result.revisions[0].snapshotJson).toBe(result.original); expect(result.revisions[1].kind).toBe('LEGACY_MEDIA_BACKFILL');
    expect(result.refs).toEqual([{ itemId: 'untouched', assetId: 'owned-asset' }]);
    expect(result.protectedAsset).toBe(true); expect(result.legacy.mediaAssetId).toBe('owned-asset');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
