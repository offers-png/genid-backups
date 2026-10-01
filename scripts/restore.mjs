#!/usr/bin/env node
// Restores a nightly backup produced by scripts/backup.mjs.
//
// Usage:
//   node scripts/restore.mjs 2026-10-01
//
// Decrypts backups/<date>/db.sql.gpg and backups/<date>/storage.tar.gpg(.part-*)
// into ./restored-<date>/ (db.sql + storage/) and stops there — it never
// applies the SQL to any database itself. That's a deliberate, separate
// step (see README.md "Restoring a backup") so this script can never be
// the thing that accidentally points at the wrong database.
//
// The storage archive is committed as <100MB chunks (storage.tar.gpg.part-aa,
// .part-ab, ...) to stay under GitHub's per-file push limit — this script
// concatenates them back into one file before decrypting. Falls back to a
// plain, unsplit storage.tar.gpg if no .part-* files exist, for any
// pre-existing backup made before chunking was added.
//
// Required environment variable:
//   BACKUP_ENCRYPTION_KEY - the same gpg passphrase used to encrypt it

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dateArg = process.argv[2]
if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('Usage: node scripts/restore.mjs YYYY-MM-DD')
  process.exit(1)
}

const passphrase = process.env.BACKUP_ENCRYPTION_KEY
if (!passphrase) {
  console.error('Missing required environment variable: BACKUP_ENCRYPTION_KEY')
  process.exit(1)
}

const repoRoot = process.cwd()
const backupDir = path.join(repoRoot, 'backups', dateArg)
const dbGpgPath = path.join(backupDir, 'db.sql.gpg')
const storageGpgPath = path.join(backupDir, 'storage.tar.gpg')

// Chunked storage archive (current format): backups/<date>/storage.tar.gpg.part-aa, -ab, ...
const storagePartPaths = fs.existsSync(backupDir)
  ? fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith('storage.tar.gpg.part-'))
      .sort()
      .map((name) => path.join(backupDir, name))
  : []

if (!fs.existsSync(dbGpgPath) || (storagePartPaths.length === 0 && !fs.existsSync(storageGpgPath))) {
  console.error(
    `No backup found at backups/${dateArg}/ (expected db.sql.gpg and either storage.tar.gpg.part-* or storage.tar.gpg)`
  )
  process.exit(1)
}

const outDir = path.join(repoRoot, `restored-${dateArg}`)
const storageOutDir = path.join(outDir, 'storage')
fs.mkdirSync(storageOutDir, { recursive: true })

function gpgDecrypt(inputPath, outputPath) {
  execFileSync(
    'gpg',
    ['--batch', '--yes', '--passphrase', passphrase, '--decrypt', '-o', outputPath, inputPath],
    { stdio: 'inherit' }
  )
}

// Concatenates the sorted storage.tar.gpg.part-* chunks back into a single
// encrypted file, or returns the plain storage.tar.gpg path unchanged if
// this backup predates chunking.
function reassembleStorageArchive(outDir) {
  if (storagePartPaths.length === 0) {
    return storageGpgPath
  }
  console.log(`Reassembling ${storagePartPaths.length} chunk(s): ${storagePartPaths.map((p) => path.basename(p)).join(', ')}`)
  const reassembledPath = path.join(outDir, 'storage.tar.gpg')
  const out = fs.openSync(reassembledPath, 'w')
  try {
    for (const partPath of storagePartPaths) {
      fs.writeSync(out, fs.readFileSync(partPath))
    }
  } finally {
    fs.closeSync(out)
  }
  return reassembledPath
}

console.log(`Decrypting backups/${dateArg}/db.sql.gpg...`)
const dbSqlPath = path.join(outDir, 'db.sql')
gpgDecrypt(dbGpgPath, dbSqlPath)
console.log(`  -> ${dbSqlPath}`)

const reassembledGpgPath = reassembleStorageArchive(outDir)
console.log(`Decrypting ${path.relative(repoRoot, reassembledGpgPath)}...`)
const storageTarPath = path.join(outDir, 'storage.tar')
gpgDecrypt(reassembledGpgPath, storageTarPath)
execFileSync('tar', ['-xf', storageTarPath, '-C', storageOutDir], { stdio: 'inherit' })
fs.rmSync(storageTarPath)
// Only clean up the reassembled copy if it was actually written into
// outDir by reassembleStorageArchive — the fallback path points straight
// at the committed backups/<date>/storage.tar.gpg, which must stay put.
if (storagePartPaths.length > 0) fs.rmSync(reassembledGpgPath)
console.log(`  -> ${storageOutDir}/`)

console.log(`
Decrypted. Next steps (see README.md "Restoring a backup" for the full
walkthrough):

  Database:
    psql "<target-connection-string>" -f ${dbSqlPath}

  Storage:
    Files are under ${storageOutDir}/<sessionId>/<file> —
    re-upload them to a Supabase Storage bucket with the Supabase CLI or
    the dashboard, preserving that same path structure.

Both ${dbSqlPath} and ${storageOutDir}/ are PLAINTEXT and contain real
user data. Delete this restored-${dateArg}/ directory when you're done
with it:

  rm -rf ${outDir}
`)
