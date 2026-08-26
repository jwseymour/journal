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

Review the plan before typing `yes` — it creates: one S3 bucket (versioned, encrypted, private), one IAM role + instance profile scoped to that bucket's `journal/*` prefix, one security group (80/443 open, 22 restricted to your IP), one EC2 instance, one Elastic IP.

Note the outputs — you'll need `instance_public_ip` and `bucket_name` below. (`terraform output` re-prints them any time.)

This repo's copy has already been validated offline (`terraform fmt` and `terraform validate`, both clean) — `apply` is the first step that actually talks to AWS.

---

## 4. DNS **[you]**

At your domain registrar, create an **A record** pointing your chosen domain/subdomain at the `instance_public_ip` from step 3. For example, `journal.yourdomain.com` → `A` → `203.0.113.10`.

This is specific to your registrar, so it's inherently manual. Give it a few minutes to propagate before step 7 (Caddy needs DNS to already resolve to request a Let's Encrypt certificate).

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

**Clone the repo** into the directory bootstrap prepared. This needs its own credential (a deploy key or a personal access token) if the repo is private — set that up however you normally do for private clones on a new machine (an SSH deploy key added to the repo's deploy keys is the cleanest option for a single always-on box):

```
sudo -u journal git clone <your-repo-url> /opt/journal/app
```

**Create `.env`:**

```
sudo -u journal cp /opt/journal/app/.env.example /opt/journal/app/.env
sudo -u journal nano /opt/journal/app/.env
```

Fill in, directly in that editor — never in a chat:

- `JOURNAL_DIR=/opt/journal/data/journal-mirror` — still required even on `s3` (it's where the local git safety-net mirror lives, `requirements.md` §7.4). Create it first: `sudo -u journal mkdir -p /opt/journal/data/journal-mirror/journal && sudo -u journal git -C /opt/journal/data/journal-mirror init`.
- `STORAGE_BACKEND=s3`
- `S3_BUCKET=<bucket_name from terraform output>`
- `AWS_REGION=<the region you deployed to>`
- Leave `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` **blank** — the instance role handles this.
- `INDEX_DB_PATH=/opt/journal/data/index.db`
- `WHISPER_CACHE_DIR=/opt/journal/data/whisper-models`
- `EMBEDDING_CACHE_DIR=/opt/journal/data/embedding-models`
- `WEB_ORIGIN=https://<your-vercel-domain>` — the Vercel URL `apps/web` is served from, so the tightened Origin check (`docs/plan.md` M11) accepts it.
- `AUTHORIZED_EMAIL=` — your Google account's address (defaults to `seymour.w.jack@gmail.com` if left unset).
- `SESSION_SECRET=` — generate one and paste it in, right there in the editor:
  ```
  openssl rand -base64 32
  ```
  This is the line that turns auth on. Leaving it blank keeps auth off, same as local dev.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from step 6 below; come back and fill these in after.
- `AUTH_PASSWORD_HASH` — leave blank for now, generate it next:
  ```
  cd /opt/journal/app && sudo -u journal npm run set-password -w @journal/api
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

Still on the box, as a sudo-capable user (not `journal`):

```
cd /opt/journal/app
sudo ./infra/deploy.sh <your-domain>
```

This installs the `journal-api` systemd unit, installs Caddy's config for your domain (which requests its Let's Encrypt certificate — this is why DNS needed to already resolve), restarts everything, and polls `/health` until it responds or times out. It prints a clear pass/fail.

If it fails, check:

```
journalctl -u journal-api -n 100 --no-pager
journalctl -u caddy -n 100 --no-pager
```

---

## 8. Migrate existing entries **[scripted, you run it — from your laptop]**

From your own machine, with `JOURNAL_DIR` pointed at your existing local journal and the AWS credentials from step 2 still configured:

```
npm run migrate-to-s3
```

It copies every entry into the bucket, then verifies entry count and a sampled set of content hashes match between source and destination. Your local `JOURNAL_DIR` is left untouched — this is a copy, not a move.

Expect output ending in something like:
```
migrated 412 entries, verified 412/412 hashes match
```
Anything less than a full match is worth stopping and investigating before treating the bucket as live.

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

Once all of those hold, the migration is live. Nothing about your local dev setup (`npm run dev`, `STORAGE_BACKEND` unset) changes — this is an additional deployment, not a replacement for it.
