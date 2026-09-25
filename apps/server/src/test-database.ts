import { readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverSourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(serverSourceDirectory, '..', '..', '..');
const migrationsDirectory = join(repositoryRoot, 'prisma', 'migrations');

function databasePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error(`Only SQLite file URLs are supported for tests: ${databaseUrl}`);
  }

  const rawPath = databaseUrl.slice('file:'.length);
  return isAbsolute(rawPath) ? rawPath : resolve(repositoryRoot, 'prisma', rawPath);
}

export async function createTestDatabase(databaseUrl: string): Promise<void> {
  const databasePath = databasePathFromUrl(databaseUrl);
  await unlink(databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });

  // Vite 5 does not know the node:sqlite builtin yet. Keeping the specifier
  // dynamic lets Node 22+ load it directly in the test runtime.
  const sqliteModule = 'node:sqlite';
  const { DatabaseSync } = await import(/* @vite-ignore */ sqliteModule) as typeof import('node:sqlite');
  const migrationDirectories = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    for (const migrationDirectory of migrationDirectories) {
      const sql = await readFile(join(migrationsDirectory, migrationDirectory, 'migration.sql'), 'utf8');
      database.exec(sql);
    }
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.argv[2] ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Pass a SQLite file URL or set DATABASE_URL.');
  await createTestDatabase(databaseUrl.startsWith('file:') ? databaseUrl : `file:${databaseUrl}`);
}
