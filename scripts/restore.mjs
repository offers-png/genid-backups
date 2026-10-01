#!/usr/bin/env node
// Restores a nightly backup produced by scripts/backup.mjs.
//
// Usage:
//   node scripts/restore.mjs 2026-10-01
//
// Decrypts backups/<date>/db.sql.gpg and backups/<date>/storage.tar.gpg
// into ./restored-<date>/ (db.sql + storage/) and stops there — it never
// applies the SQL to any database itself. That's a deliberate, separate
// step (see README.md "Restoring a backup") so this script can never be
// the thing that accidentally points at the wrong database.
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

if (!fs.existsSync(dbGpgPath) || !fs.existsSync(storageGpgPath)) {
  console.error(`No backup found at backups/${dateArg}/ (expected db.sql.gpg and storage.tar.gpg)`)
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

console.log(`Decrypting backups/${dateArg}/db.sql.gpg...`)
const dbSqlPath = path.join(outDir, 'db.sql')
gpgDecrypt(dbGpgPath, dbSqlPath)
console.log(`  -> ${dbSqlPath}`)

console.log(`Decrypting backups/${dateArg}/storage.tar.gpg...`)
const storageTarPath = path.join(outDir, 'storage.tar')
gpgDecrypt(storageGpgPath, storageTarPath)
execFileSync('tar', ['-xf', storageTarPath, '-C', storageOutDir], { stdio: 'inherit' })
fs.rmSync(storageTarPath)
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
