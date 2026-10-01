#!/usr/bin/env node
// Nightly backup for the GenID Protocol database and storage bucket.
//
// Produces, under backups/<YYYY-MM-DD>/ relative to the repo root:
//   db.sql.gpg       - gpg-symmetric-encrypted plain-text pg_dump of the
//                       whole public schema
//   storage.tar.gpg  - gpg-symmetric-encrypted tar of every object in the
//                       genid-sessions storage bucket
//
// Also deletes any backups/<YYYY-MM-DD>/ directory older than
// RETENTION_DAYS (default 30), so the repo doesn't grow forever.
//
// Required environment variables:
//   SUPABASE_DB_URL          - direct Postgres connection string
//                               (Supabase dashboard -> Settings -> Database
//                               -> Connection string -> URI, "Direct
//                               connection", not the pooler/REST URL)
//   SUPABASE_SERVICE_ROLE_KEY
//   NEXT_PUBLIC_SUPABASE_URL - same project URL the app itself uses
//   BACKUP_ENCRYPTION_KEY    - gpg symmetric passphrase
//
// This script only ever reads from Supabase and writes to a local
// directory — it never commits or pushes anything itself. See
// .github/workflows/nightly-backup.yml for that half.

import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'

const BUCKET = 'genid-sessions'
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30)
const REPO_ROOT = process.cwd()
const BACKUPS_DIR = path.join(REPO_ROOT, 'backups')

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return value
}

function todayDateStamp() {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD, UTC
}

function gpgEncrypt(inputPath, outputPath, passphrase) {
  execFileSync(
    'gpg',
    ['--batch', '--yes', '--passphrase', passphrase, '--symmetric', '--cipher-algo', 'AES256', '-o', outputPath, inputPath],
    { stdio: 'inherit' }
  )
}

// ---- Database ----

function dumpDatabase(dbUrl, outSqlPath) {
  console.log('Dumping database with pg_dump...')
  // Plain SQL text so the backup is restorable with nothing but psql, and
  // the encrypted artifact's own name (db.sql.gpg) is literally accurate.
  // --no-owner/--no-privileges: this project's roles won't exist as-is in
  // a fresh restore target; the schema/data matter, not role ownership.
  execFileSync(
    'pg_dump',
    [dbUrl, '--format=plain', '--no-owner', '--no-privileges', '--file', outSqlPath],
    { stdio: 'inherit' }
  )
}

// ---- Storage ----

// Supabase Storage's .list() is one level at a time — "folders" come back
// as entries with no `id`/`metadata`. genid-sessions is organized as
// <sessionId>/<file>, so this recurses one extra level per discovered
// prefix; it isn't bounded to a fixed depth, so a deeper bucket layout in
// the future still gets walked correctly.
async function listAllObjects(supabase, prefix = '') {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 })
  if (error) throw new Error(`Failed to list storage path "${prefix}": ${error.message}`)

  const files = []
  for (const entry of data ?? []) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.id === null) {
      // A "folder" placeholder — recurse into it.
      files.push(...(await listAllObjects(supabase, entryPath)))
    } else {
      files.push(entryPath)
    }
  }
  return files
}

async function downloadAllObjects(supabase, localDir) {
  console.log(`Listing objects in bucket "${BUCKET}"...`)
  const objectPaths = await listAllObjects(supabase)
  console.log(`Found ${objectPaths.length} object(s). Downloading...`)

  for (const objectPath of objectPaths) {
    const { data, error } = await supabase.storage.from(BUCKET).download(objectPath)
    if (error) {
      // Non-fatal: a single missing/transient object shouldn't abort the
      // whole nightly backup. Logged clearly so it's visible in the
      // workflow run's output.
      console.error(`  [skip] ${objectPath}: ${error.message}`)
      continue
    }
    const destPath = path.join(localDir, objectPath)
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, Buffer.from(await data.arrayBuffer()))
  }

  return objectPaths.length
}

function tarDirectory(localDir, outTarPath) {
  // -C so the tar's internal paths are relative to the bucket root
  // (<sessionId>/<file>), not an absolute host path.
  execFileSync('tar', ['-cf', outTarPath, '-C', localDir, '.'], { stdio: 'inherit' })
}

// ---- Retention ----

function pruneOldBackups(backupsDir, retentionDays) {
  if (!fs.existsSync(backupsDir)) return
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const entry of fs.readdirSync(backupsDir)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry)
    if (!match) continue // ignore anything that isn't a dated backup dir
    const entryDate = Date.parse(entry) // YYYY-MM-DD parses as UTC midnight
    if (!Number.isNaN(entryDate) && entryDate < cutoff) {
      console.log(`Pruning backup older than ${retentionDays} days: ${entry}`)
      fs.rmSync(path.join(backupsDir, entry), { recursive: true, force: true })
    }
  }
}

// ---- Main ----

async function main() {
  const dbUrl = requireEnv('SUPABASE_DB_URL')
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const encryptionKey = requireEnv('BACKUP_ENCRYPTION_KEY')

  const dateStamp = todayDateStamp()
  const outDir = path.join(BACKUPS_DIR, dateStamp)
  fs.mkdirSync(outDir, { recursive: true })

  const tmpDir = fs.mkdtempSync('/tmp/genid-backup-')
  const dbSqlPath = path.join(tmpDir, 'db.sql')
  const storageDir = path.join(tmpDir, 'storage')
  const storageTarPath = path.join(tmpDir, 'storage.tar')
  fs.mkdirSync(storageDir, { recursive: true })

  dumpDatabase(dbUrl, dbSqlPath)
  console.log(`Database dump: ${fs.statSync(dbSqlPath).size} bytes`)

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const objectCount = await downloadAllObjects(supabase, storageDir)
  tarDirectory(storageDir, storageTarPath)
  console.log(`Storage archive: ${objectCount} object(s), ${fs.statSync(storageTarPath).size} bytes`)

  console.log('Encrypting...')
  gpgEncrypt(dbSqlPath, path.join(outDir, 'db.sql.gpg'), encryptionKey)
  gpgEncrypt(storageTarPath, path.join(outDir, 'storage.tar.gpg'), encryptionKey)

  // Clean up plaintext immediately — nothing unencrypted should linger on
  // disk any longer than it takes to encrypt it.
  fs.rmSync(tmpDir, { recursive: true, force: true })

  pruneOldBackups(BACKUPS_DIR, RETENTION_DAYS)

  console.log(`Done. Backup written to backups/${dateStamp}/`)
}

main().catch((err) => {
  console.error('Backup failed:', err)
  process.exit(1)
})
