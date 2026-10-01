# genid-backups

Nightly encrypted backups of the [GenID Protocol](https://github.com/offers-png/genid) database and storage bucket.

This repo exists because, as of October 2026, the production Supabase project (`wzcuzyouymauokijaqjk`, free tier) has **no backups of any kind** — no point-in-time recovery, no daily snapshots, no `pg_cron` job. If that project is lost, corrupted, or the account is locked out, this is the only copy of the data.

**If you're reading this because something has gone wrong with the main account or project** — skip to [Restoring a backup](#restoring-a-backup). You don't need write access to the original Supabase project to read a backup out of this repo; you only need the three secrets listed below (ask whoever has them, or check wherever your team stores credentials — this repo intentionally never stores them in cleartext anywhere, including here).

## What gets backed up, and when

A GitHub Actions workflow ([`.github/workflows/nightly-backup.yml`](.github/workflows/nightly-backup.yml)) runs every night at **09:00 UTC** (and can be triggered manually from the Actions tab):

1. **Database** — a full `pg_dump` of the public schema (plain SQL, via the direct Postgres connection, not the REST API).
2. **Storage** — every object in the `genid-sessions` bucket (step images, archived copies, certificate PDFs, C2PA exports), downloaded via the service-role key and packed into a tarball.

Both are encrypted with `gpg --symmetric` (AES-256) before anything touches disk in this repo. The database dump is small enough (currently ~15MB) to commit as a single file. The storage archive is not — GitHub hard-rejects any pushed file over 100MB (`GH001: Large files detected`), and the encrypted storage tarball has already crossed that — so it's split into ~90MB chunks (`split -b 90m`) before committing, named with the default alphabetic suffixes:

```
backups/
  2026-10-01/
    db.sql.gpg
    storage.tar.gpg.part-aa
    storage.tar.gpg.part-ab
    storage.tar.gpg.part-ac
  2026-10-02/
    db.sql.gpg
    storage.tar.gpg.part-aa
    storage.tar.gpg.part-ab
  ...
```

The number of `.part-*` chunks varies run to run with how much is in the bucket — there's no fixed count. The unsplit `storage.tar.gpg` is never written into `backups/` or committed; it only ever exists briefly in a temp directory during the backup run. `scripts/restore.mjs` reassembles the chunks back into one file automatically (see [Restoring a backup](#restoring-a-backup)) — you never need to do this by hand.

**Retention: 30 days.** Each run also deletes any `backups/<date>/` directory older than 30 days, so this repo's history doesn't grow forever. If you need to keep a specific backup longer than that, copy its folder out before it ages out, or clone the repo at the right historical commit (git history itself isn't pruned, only the working tree — see [Keeping a backup past 30 days](#keeping-a-backup-past-30-days)).

## Why this is a separate, private repo

- **Blast radius.** This repo holds real user PII — names, emails, Stripe verification IDs — and content hashes, encrypted at rest but still sensitive metadata (who has access to this repo, who committed what, when). Keeping it separate from the application repo means access to one doesn't imply access to the other.
- **Independent of the app's deploy pipeline.** If Render, the app repo, or the primary GitHub account tied to deploys is ever compromised or locked out, this repo and its backups are unaffected as long as whoever needs them has the three secrets below.

## Required secrets

Set these under **Settings → Secrets and variables → Actions** on this repo. None of them are stored anywhere in this repo's code or history — only as GitHub Actions secrets.

| Secret | Where to get it | Sensitive? |
|---|---|---|
| `SUPABASE_DB_URL` | Supabase dashboard → the `genid` project → **Settings → Database → Connection string** → **URI** tab → **Direct connection** (not "Transaction pooler" / "Session pooler" — those don't support arbitrary `pg_dump` well). Includes the DB password. | Yes — full read/write access to the database. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → **Settings → API → Project API keys → `service_role`**. Same key the deployed app already uses (`SUPABASE_SERVICE_ROLE_KEY` in Render's env vars). | Yes — bypasses all Row Level Security. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → **Settings → API → Project URL** (e.g. `https://wzcuzyouymauokijaqjk.supabase.co`). This is the same public project URL baked into the app's own client-side code — not a secret by nature, but there's no other place for the script to read it from in a standalone repo. | No, but still only set as a secret here for convenience/consistency. |
| `BACKUP_ENCRYPTION_KEY` | A long random passphrase you generate once and store safely (a password manager, not a sticky note). **If this is lost, every backup in this repo becomes permanently unrecoverable.** Generate one with `openssl rand -base64 32`. | Yes — this is what makes every backup unreadable without it. |

Until these are set, the nightly workflow will run and fail immediately (missing env var — see `scripts/backup.mjs`'s `requireEnv` checks) without committing anything. That's intentional: a failed run that commits nothing is safe; the alternative is not.

## How the pipeline works

- [`scripts/backup.mjs`](scripts/backup.mjs) — does the actual work: `pg_dump`, list + download every storage object, `tar`, `gpg --symmetric` both artifacts, split the encrypted storage archive into `.part-*` chunks, write everything to `backups/<today>/`, delete anything older than 30 days. Never commits or pushes anything itself — pure file I/O against the local checkout.
- [`.github/workflows/nightly-backup.yml`](.github/workflows/nightly-backup.yml) — installs PostgreSQL client 17 (matching Supabase's server version, for `pg_dump`) and Node, runs the script above with the four secrets as env vars, then commits and pushes `backups/` if anything changed.
- [`scripts/restore.mjs`](scripts/restore.mjs) — the inverse: reassembles a given date's `storage.tar.gpg.part-*` chunks (falling back to a plain `storage.tar.gpg` for any pre-chunking backup), then decrypts that alongside `db.sql.gpg` into a local `restored-<date>/` directory. It deliberately stops there and never applies the SQL to any database itself — see below for why that's a separate, manual step.

## Restoring a backup

### 1. Clone this repo (if you don't already have it)

```bash
git clone https://github.com/offers-png/genid-backups
cd genid-backups
npm install
```

### 2. Decrypt the backup you want

```bash
export BACKUP_ENCRYPTION_KEY="<the passphrase from the secrets table above>"
node scripts/restore.mjs 2026-10-01   # use whichever date you need
```

This produces:

```
restored-2026-10-01/
  db.sql              <- plaintext SQL dump
  storage/
    <sessionId>/
      step_1.png
      certificate.pdf
      ...
```

Under the hood, `restore.mjs` first concatenates that date's `storage.tar.gpg.part-aa`, `.part-ab`, ... chunks (sorted) back into one encrypted file before decrypting — you don't need to do this yourself. (If a backup predates chunking and only has a plain `storage.tar.gpg`, it decrypts that directly instead.)

**Both are plaintext and contain real user data.** Don't commit them anywhere, and delete the `restored-<date>/` directory as soon as you're done (the script reminds you of this at the end, and prints the exact `rm -rf` command).

If you don't have Node available, the equivalent manual steps are:

```bash
gpg --batch --passphrase "$BACKUP_ENCRYPTION_KEY" --decrypt -o db.sql backups/2026-10-01/db.sql.gpg

# Reassemble the storage chunks (there may be one or several, depending on
# how much was in the bucket that night), then decrypt the result:
cat backups/2026-10-01/storage.tar.gpg.part-* > storage.tar.gpg
gpg --batch --passphrase "$BACKUP_ENCRYPTION_KEY" --decrypt -o storage.tar storage.tar.gpg
mkdir storage && tar -xf storage.tar -C storage
```

### 3. Restore the database

Decide where it's going first — **never point this at the live production project unless you specifically mean to overwrite it.** For recovery, that usually means either a fresh/empty Supabase project, or (if Supabase branching is available on the target project's plan — it wasn't on the free tier this was built against) a throwaway branch.

```bash
psql "<target-connection-string>" -f restored-2026-10-01/db.sql
```

If the target database isn't empty, you'll get conflict errors on primary keys/unique constraints — that's expected and safe (it means you're not overwriting anything by accident). Restoring into a fresh database is the normal case.

### 4. Restore storage

The decrypted `storage/<sessionId>/<file>` layout mirrors the `genid-sessions` bucket exactly. Re-upload with the Supabase CLI:

```bash
supabase storage cp -r restored-2026-10-01/storage/* ss:///genid-sessions --project-ref <target-project-ref>
```

or drag-and-drop the folder contents through the dashboard's Storage UI, preserving the `<sessionId>/<file>` structure.

### 5. Verify, then clean up

Spot-check a few rows/files, then:

```bash
rm -rf restored-2026-10-01
```

### How this was proven to actually work

Before this pipeline went live, the full restore path was validated against **real production data** (not synthetic test files) in a way that never touched the live `public` schema:

1. Supabase branching was attempted first (`create_branch`), as the cleanest way to test against a throwaway copy — it's unavailable on this project's free tier (both attempts failed outright).
2. Instead, real rows were pulled from the live `genid_registry` table, dumped to SQL, encrypted with `gpg --symmetric`, decrypted, and restored into a dedicated throwaway schema in the *same* project (never `public`).
3. Row count and a full-row MD5 hash were compared between the source table and the restored copy — **exact match**.
4. The throwaway schema was dropped immediately after.

Separately, `scripts/restore.mjs` itself (the actual script in this repo, not a manual re-implementation of its steps) was run end-to-end against a synthetic backup pair to confirm the script's own decrypt/extract logic produces byte-identical output — including a sample file opening correctly after decryption.

**Split-chunk storage archives.** When the real nightly run's encrypted storage tarball first crossed GitHub's 100MB per-file push limit, `scripts/backup.mjs` was changed to split it into `.part-*` chunks and `scripts/restore.mjs` to reassemble them. That round trip was verified the same way, against the real scripts:
1. A synthetic storage tree (including a multi-megabyte binary file, to rule out a text-only false pass) was tarred and gpg-encrypted, then split into 6 chunks with the same `split -b <size> -a 2` invocation `backup.mjs` uses.
2. The real `scripts/restore.mjs` — unmodified, run exactly as the nightly workflow or a human would run it — was pointed at that chunked backup. It correctly detected all 6 `.part-*` files, reassembled them in order, decrypted the result, and extracted the tar.
3. The restored tree was byte-for-byte identical to the original (`diff -r`, plus a SHA-256 match on the binary file), and the intermediate reassembled `.gpg` file was cleaned up afterward, exactly as the script's own logic is supposed to do.
4. The backward-compatibility fallback was verified separately: a legacy, unsplit `storage.tar.gpg` with no `.part-*` siblings was restored by the same script and decrypted/extracted correctly without alteration.

What this means in practice: the **encrypt → decrypt → restore → verify** mechanism is proven correct against this project's real schema and real data, and the **split → reassemble → decrypt** mechanism is proven correct against synthetic data standing in for a real oversized storage archive. The one thing that could only be exercised for real once secrets are configured is pulling genuinely live data through the actual nightly GitHub Actions run (`pg_dump` against the real direct connection, real storage downloads with the real service-role key, the real chunk count and sizes that come out of that) — that happens on each real scheduled or manually-triggered run.

## Keeping a backup past 30 days

The pruning step only deletes files from the *working tree* on each run — it doesn't rewrite git history. A backup that's been pruned from `backups/` is still recoverable from an older commit:

```bash
git log --oneline --diff-filter=D -- 'backups/2026-08-01/*'   # find the commit that deleted it
git show <commit>^:backups/2026-08-01/db.sql.gpg > db.sql.gpg  # pull it back out
```

If you need to keep something indefinitely, it's simpler to just copy that date's folder out of the repo (or to cloud storage) before it ages out.

## If the main GenID account or project is ever lost

This repo and its secrets are the recovery path. Concretely:

1. Get the three secrets (`SUPABASE_DB_URL` won't work if the project itself is gone — in that case you're restoring into a brand-new Supabase project instead, so you only need `BACKUP_ENCRYPTION_KEY` to decrypt).
2. Create a fresh Supabase project if needed, run the application's own migrations from `offers-png/genid`'s `supabase/migrations/` directory first (so the schema/extensions/functions exist), then follow [Restoring a backup](#restoring-a-backup) above to repopulate it with real data.
3. Re-upload storage objects the same way.
4. Update the application's env vars (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) to point at the new project.

Whoever does this won't have any context from whoever set this up originally — that's the entire point of this document existing. If something here is unclear when you actually need it, that's a bug in this README; fix it once you've figured out the missing step, for the next person.
