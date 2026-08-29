# Deployment runbook — M11 (S3 storage, single-user auth, EC2 host)

*This is an operational runbook, not a statement of intent — it sits outside the canonical document set `CLAUDE.md` defines (`requirements.md` / `format.md` / `design.md` / `plan.md`) and carries no authority over any of them. It just tells you, in order, what to actually do to go from "code merged" to "live." See `docs/plan.md` M11 for what was built and why.*

Every step below is marked **[you]** (needs your own identity, account, or a value that must never appear in a chat with an AI assistant) or **[scripted]** (already built — Terraform, a shell script, or a systemd unit in `infra/`, that you run). Nothing in this document asks you to paste a secret into a conversation with an AI assistant. Secrets go straight from your terminal into a file, every time.

---

## 0. What this produces

- An S3 bucket holding the canonical journal (`docs/plan.md` §7.3), versioned and encrypted, no public access.
- One `t4g.micro` EC2 instance running `apps/api`, authenticating to that bucket via an **IAM instance role** — no AWS access key exists anywhere on the box or in its `.env`.
- Caddy on that instance terminating HTTPS (Let's Encrypt) and reverse-proxying to the API.
- Single-user auth (Google OAuth + password fallback) gating every route except `/health` and `/auth/*`.
- `apps/web`, already on Vercel, pointed at the new API domain.

Rough monthly cost, honestly ballparked (AWS pricing changes — verify current numbers before committing):
- S3: a personal text-and-photo journal is a few GB at most — a dollar or less a month.
- `t4g.micro` + 30GB `gp3` EBS + an Elastic IP while attached to a running instance: roughly $6–10/month, us/eu regions, on-demand pricing.
- A domain name, if you don't already have one: typically $10–15/year, a one-off/annual cost, not monthly.

---

## 1. Prerequisites **[you]**

- **An AWS account.** Decide: your own, or the one your dad showed you. This runbook assumes whichever account you use has billing already set up and you can create IAM roles/S3 buckets/EC2 instances in it.
- **A domain name you control**, or a subdomain of one. If you don't have one yet, buy one now (any registrar) — it's the one step here you can't skip and can't script.
- **Terraform** and the **AWS CLI**, installed locally:
  ```
  brew install hashicorp/tap/terraform awscli
  ```
- **An existing EC2 key pair** in the region you'll deploy to (create one if you don't have one — command in step 3).

---

## 2. AWS credentials, locally, once **[you]**

Run this yourself in your own terminal (type `!aws configure` in a Claude Code session to run it there, so the credential never has to be typed to an assistant):

```
aws configure
```

This is the **only** place a static AWS credential should ever exist — on your own laptop, for Terraform and the migration script to use. It never goes on the server (which authenticates via its IAM role instead) and never gets pasted anywhere else.

If your AWS account uses SSO instead, use `aws sso login` per your organization's setup instead of static keys.

---

## 3. Provision the infrastructure **[scripted, you run it]**

Create the EC2 key pair, if you don't already have one for this region:

```
aws ec2 create-key-pair --key-name journal-key \
  --query 'KeyMaterial' --output text > ~/.ssh/journal-key.pem
chmod 400 ~/.ssh/journal-key.pem
```

Find your own IP, for the SSH allowlist:

```
curl -4 ifconfig.me
```

Then:

```
cd infra/terraform
terraform init
terraform apply \
  -var="bucket_name=<something-globally-unique>" \
  -var="ssh_allowed_cidr=<your-ip>/32" \
  -var="key_pair_name=journal-key"
```

Review the plan before typing `yes` — it creates: one S3 bucket (versioned, encrypted, private), an instance role + profile scoped to that bucket's `public/*` prefix read-only (what the box gets by default), a second, broader role scoped to `journal/*`/`documents/*`/`public/*` read-write that only that instance role can assume, one security group (80/443 open, 22 restricted to your IP), one EC2 instance, one Elastic IP.

Note the outputs — you'll need `instance_public_ip`, `bucket_name`, and `s3_assume_role_arn` below. (`terraform output` re-prints them any time.)

This repo's copy has already been validated offline (`terraform fmt` and `terraform validate`, both clean) — `apply` is the first step that actually talks to AWS.

---

## 4. DNS **[you]**

At your domain registrar, create an **A record** pointing your chosen domain/subdomain at the `instance_public_ip` from step 3. For example, `journal.yourdomain.com` → `A` → `203.0.113.10`.

If you're also deploying `apps/public-api` (step 7 covers this — optional, skip it if you're not publishing anything yet), create a second **A record**, at a different subdomain, pointing at the same `instance_public_ip` — e.g. `public.yourdomain.com` → `A` → `203.0.113.10`. Both run on the one instance behind Caddy, each on its own domain.

This is specific to your registrar, so it's inherently manual. Give it a few minutes to propagate before step 7 (Caddy needs DNS to already resolve to request a Let's Encrypt certificate) — for both domains, if you're using two.

---

## 5. First login to the box **[you, with scripted pieces]**

```
ssh -i ~/.ssh/journal-key.pem ubuntu@<instance_public_ip>
```

`infra/bootstrap.sh` already ran automatically as part of first boot (it's wired in as EC2 user-data by Terraform) — Node 20, Caddy, and the `journal` service user should already be there. Confirm:

```
node -v      # should be 20.x
caddy version
id journal
```

**Clone the repo.** GitHub no longer accepts a password over HTTPS for git operations, so this needs an SSH deploy key. Generate one as `ubuntu` (the `journal` account has no shell to run interactive commands with):

```
ssh-keygen -t ed25519 -C "journal-ec2-deploy-key" -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Add the printed key at `https://github.com/<owner>/<repo>/settings/keys` → **Add deploy key** → paste it → leave "Allow write access" unchecked → Add key.

Then give the `journal` user its own copy — its home directory is `/opt/journal` (set by `useradd --home-dir /opt/journal` in `bootstrap.sh`), not `/home/journal`:

```
sudo mkdir -p /opt/journal/.ssh
sudo cp ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub /opt/journal/.ssh/
ssh-keyscan -H github.com | sudo tee -a /opt/journal/.ssh/known_hosts > /dev/null
sudo chown -R journal:journal /opt/journal/.ssh
sudo chmod 700 /opt/journal/.ssh
sudo chmod 600 /opt/journal/.ssh/id_ed25519
```

`/opt/journal` itself isn't traversable by `ubuntu` (`journal`'s home is `750`), so clone with an explicit `sudo -u journal`, not a plain `cd` first — a bare `cd /opt/journal/app` as `ubuntu` fails with "Permission denied", which is expected:

```
sudo -u journal git clone git@github.com:<owner>/<repo>.git /opt/journal/app
```

**Create `.env`:**

```
sudo -u journal cp /opt/journal/app/.env.example /opt/journal/app/.env
sudo -u journal nano /opt/journal/app/.env
```

Fill in, directly in that editor — never in a chat. Every line below is commented out (`# `) in `.env.example` — **uncomment it**, not just add a value after the `=`, or the app never sees it:

- `JOURNAL_DIR=/opt/journal/data/journal-mirror` — still required even on `s3` (it's where the local git safety-net mirror lives, `requirements.md` §7.4). Create it first: `sudo -u journal mkdir -p /opt/journal/data/journal-mirror/journal && sudo -u journal git -C /opt/journal/data/journal-mirror init`.
- `STORAGE_BACKEND=s3`
- `S3_BUCKET=<bucket_name from terraform output>`
- `AWS_REGION=<the region you deployed to>`
- Leave `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` **blank** — the instance role handles this.
- `S3_ASSUME_ROLE_ARN=<s3_assume_role_arn from terraform output>` — the instance's own role only reads `public/*`; this is the broader role `apps/api` assumes via STS to reach `journal/*`/`documents/*`. Without it, `apps/api` can only ever read/write `public/*` and every entry/document read or write will fail.
- `INDEX_DB_PATH=/opt/journal/data/index.db`
- `WHISPER_CACHE_DIR=/opt/journal/data/whisper-models`
- `EMBEDDING_CACHE_DIR=/opt/journal/data/embedding-models`
- `AI_GATEWAY_API_KEY=` — a Vercel AI Gateway key. Without this, extraction is
  entirely unconfigured: `/analysis` stays empty forever (no metrics,
  reviews, lists, opinions, questions, or todos ever get produced, live or
  batch), every `POST /entries/:id/process` fails `extraction_failed`, and
  `npm run reprocess` refuses to run at all. This is easy to skip because
  nothing *breaks* without it — the journal itself still reads and writes
  fine — so it is worth deliberately confirming rather than assuming step 7
  or step 8 will remind you.
- `EXTRACTION_MODEL=` / `CHAT_MODEL=` — leave both unset to take the
  built-in defaults (`config.ts`), or set them to pin a specific model.
- `WEB_ORIGIN=https://<your-vercel-domain>` — the Vercel URL `apps/web` is served from, so the tightened Origin check (`docs/plan.md` M11) accepts it.
- `PUBLIC_URL=https://<your-domain>` — this server's own address (the one from step 4's DNS record, e.g. `https://api.example.com`), used to build the Google OAuth redirect and to accept requests proxied under this domain. Without it, Google sign-in fails with `redirect_uri_mismatch` and every request gets rejected as `forbidden_origin` once behind a real domain.
- Only if you're deploying `apps/public-api` (step 7): `BLOG_ORIGIN=https://<your-blog-domain>` — the blog frontend's own origin, the only thing this unauthenticated surface gates on. `PUBLIC_API_HOST`/`PUBLIC_API_PORT` can stay at their defaults (`127.0.0.1`/`4320`) unless something else on the box already uses that port.
- `AUTHORIZED_EMAIL=` — your Google account's address (defaults to `seymour.w.jack@gmail.com` if left unset).
- `SESSION_SECRET=` — generate one and paste it in, right there in the editor:
  ```
  openssl rand -base64 32
  ```
  This is the line that turns auth on. Leaving it blank keeps auth off, same as local dev.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from step 6 below; come back and fill these in after.
- `AUTH_PASSWORD_HASH` — leave blank for now, generate it next. This needs dependencies installed first (`npm run set-password` is a workspace script), which normally happens in step 7 — do it now instead:
  ```
  sudo -u journal bash -c 'cd /opt/journal/app && npm ci'
  ```
  (`/opt/journal` isn't traversable by `ubuntu`, so wrap the `cd` inside the `sudo -u journal` shell — a bare `cd /opt/journal/app` first fails with "Permission denied".) Then:
  ```
  sudo -u journal bash -c 'cd /opt/journal/app && npm run set-password -w @journal/api'
  ```
  It prompts for a password and prints an argon2id hash. Paste the hash (not the password) into `.env`.

---

## 6. Google OAuth client **[you]**

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (or reuse one), if you don't have one for this.
2. **APIs & Services → OAuth consent screen** — set it up for "External" (or "Internal" if you're on a Workspace account and want to restrict it further), app name whatever you like. You're the only user this ever needs to authorize.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID.**
   - Application type: **Web application**.
   - Authorized redirect URI: `https://<your-domain>/api/auth/google/callback`
4. Copy the **Client ID** and **Client secret** it gives you — straight into `/opt/journal/app/.env` on the box (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), never into a chat.

(The `/api/...` prefix matters — that's the path `apps/web`'s reverse proxy forwards to the API's `/auth/google/callback`, per `docs/plan.md` M11.)

---

## 7. First deploy **[scripted, you run it]**

Still on the box, as a sudo-capable user (not `journal` — it has no shell to run this with anyway):

```
sudo /opt/journal/app/infra/deploy.sh <your-domain>
```

Add a second domain to also install and start `apps/public-api`, if you've set up its DNS record and `.env` values (steps 4 and 5 above) — omit it entirely if you're not publishing anything yet, and run this exact one-argument form later, once you are:

```
sudo /opt/journal/app/infra/deploy.sh <your-domain> <your-public-api-domain>
```

(Run the script by its full path rather than `cd`-ing there first — `/opt/journal` isn't traversable by a non-`sudo` user, so a plain `cd /opt/journal/app` fails with "Permission denied.")

This installs the `journal-api` systemd unit (and `journal-public-api` too, if a second domain was given), installs Caddy's config for each domain (which requests its own Let's Encrypt certificate — this is why DNS needed to already resolve), restarts everything, and polls each service's `/health` until it responds or times out. It prints a clear pass/fail for each.

If it fails, check:

```
journalctl -u journal-api -n 100 --no-pager
journalctl -u journal-public-api -n 100 --no-pager
journalctl -u caddy -n 100 --no-pager
```

---

## 8. Migrate existing entries and documents **[scripted, you run it — from your laptop]**

From your own machine, with `JOURNAL_DIR` pointed at your existing local journal (already the case in your local `.env`) and the AWS credentials from step 2 still configured. The script itself needs `STORAGE_BACKEND=s3`/`S3_BUCKET`/`AWS_REGION` to know where to copy *to* — rather than permanently switching your local dev setup over to S3, set them just for this one command:

```
STORAGE_BACKEND=s3 S3_BUCKET=<bucket_name> AWS_REGION=<region> npm run migrate-to-s3
```

It copies every entry, attachment, and document into the bucket, then verifies entry count, document count, and a sampled set of content hashes match between source and destination on both. Your local `JOURNAL_DIR` is left untouched — this is a copy, not a move.

Expect output ending in something like:
```
[journal] copied 412 files
[journal] verifying...
[journal] entry count matches: 380
[journal] content hash matches on 25 sampled entries
[journal] document count matches: 6
[journal] content hash matches on 6 sampled documents
[journal] migration verified. ...
```
A thrown error at any point (a count mismatch, a sampled hash mismatch, on either entries or documents) is worth stopping and investigating before treating the bucket as live.

**This alone doesn't make the entries and documents show up on the running server** — its index (`index.db`) was already built empty, before the migration, and won't notice new S3 objects on its own. Rebuild it, back on the box:

```
sudo systemctl stop journal-api
sudo -u journal rm -f /opt/journal/data/index.db /opt/journal/data/index.db-shm /opt/journal/data/index.db-wal
sudo -u journal bash -c 'cd /opt/journal/app && npm run rebuild -w @journal/api'
sudo systemctl start journal-api
```

(Stop the service first — deleting the database out from under a running process leaves stale `-shm`/`-wal` files behind that confuse the next open, surfacing as a `SQLITE_IOERR_SHORT_READ`.) Confirm with `curl https://<your-domain>/health` — `entryCount` should match what step 8 just reported.

**The index now knows your entries exist, but nothing has been extracted from them yet** — `/analysis` will still be empty. `index.ts` boot only ever opens the index; it never runs extraction on your behalf (`plan.md` M7). If `AI_GATEWAY_API_KEY` is set (step 5), backfill the whole corpus once, from your laptop, the same way you'd run it locally:

```
STORAGE_BACKEND=s3 S3_BUCKET=<bucket_name> AWS_REGION=<region> AI_GATEWAY_API_KEY=<key> npm run reprocess -w @journal/api
```

This is a real API call per entry per structure type — expect it to take a while and cost a small, predictable amount, proportional to corpus size. From here on, day-to-day extraction for a *new* entry runs live, the moment you finish writing it or finish an edit (`POST /entries/:id/process`, `plan.md` M15) — this one-time backfill is only for entries that already existed before the key was configured.

---

## 9. Point Vercel at the real API **[you]**

In the Vercel project's environment variables (Production), set:

```
API_INTERNAL_URL=https://<your-domain>
```

(and `NEXT_PUBLIC_API_URL` too, only if `apps/web` and the API end up on genuinely different origins rather than proxied through the same one — see `.env.example`'s comment on this). Redeploy the Vercel project for the change to take effect.

---

## 10. Go-live checklist

Mirrors `docs/plan.md` M11's "Done when":

- [ ] `entry-store-contract.test.ts` passes locally against both backends (already true as of this runbook being written — 745/745).
- [ ] `aws s3 sync s3://<bucket>/journal/ /tmp/check` produces a directory that diffs clean against a known-good local copy.
- [ ] On the box: `sudo -u journal rm /opt/journal/data/index.db && cd /opt/journal/app && sudo -u journal npm run rebuild-index` reproduces the index against `STORAGE_BACKEND=s3` without error.
- [ ] From outside: a bare `curl https://<your-domain>/entries` (no cookie) returns `401 unauthorized`, not a silent 200.
- [ ] Logging in via the browser (`https://<your-vercel-domain>/login`) with the Google button, and separately with the password, both work.
- [ ] Writing a new entry through the real UI lands a real object in the S3 bucket (check via `aws s3 ls s3://<bucket>/journal/ --recursive`).
- [ ] `AI_GATEWAY_API_KEY` is actually set (not just present-and-commented-out) — `curl https://<your-domain>/health` doesn't prove this either way; check the `journal-api` service's own boot log instead: `journalctl -u journal-api -n 50 --no-pager | grep -i extraction` should say which model, not `AI_GATEWAY_API_KEY not set`.
- [ ] `/analysis` in the real UI shows real data, not an empty page — if it doesn't and the key is set, the one-time backfill (step 8) hasn't been run yet.

Once all of those hold, the migration is live. Nothing about your local dev setup (`npm run dev`, `STORAGE_BACKEND` unset) changes — this is an additional deployment, not a replacement for it.

---

## 11. If you also deployed `apps/public-api` (`plan.md` M14/M15)

Only relevant if you passed a second domain in step 7. Mirrors `plan.md` M14's "Done when," checked for real against this deployment rather than only against the test suite:

- [ ] Publish a document (or entry) through the real, authenticated UI. `curl https://<your-public-api-domain>/documents` (or `/entries`) returns it, unauthenticated, within a few seconds.
- [ ] Unpublish it. The same `curl` no longer lists it, and fetching its `:slug` route directly 404s.
- [ ] From the box, confirm the IAM split is real rather than assumed: `curl http://169.254.169.254/latest/meta-data/iam/security-credentials/` names the instance role, and a raw AWS CLI call under those credentials (`AWS_EC2_METADATA_DISABLED=false aws s3 ls s3://<bucket>/journal/` with no other credentials configured) is denied — `journal_api_write` is a role `apps/api` explicitly assumes, never the box's ambient identity.
- [ ] `journalctl -u journal-public-api -n 50 --no-pager` shows no errors on boot or on a publish/unpublish cycle.
