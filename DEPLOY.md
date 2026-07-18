# Deploying

Push to `main` → GitHub Actions typechecks, rsyncs the repo to the droplet, and
swaps it into place. Cron picks up the new code on its next run. There is no
build step and no daemon to restart.

The server holds **no GitHub credentials** — Actions pushes to it, it never pulls.

## One-time setup

### 1. Deploy key (you run these — never paste a private key into a chat)

On your machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/bubber_deploy -N "" -C "github-actions-deploy"
ssh-copy-id -i ~/.ssh/bubber_deploy.pub deploy@YOUR_HOST
ssh-keyscan YOUR_HOST 2>/dev/null        # copy this output for DEPLOY_KNOWN_HOSTS
cat ~/.ssh/bubber_deploy                 # the private key, for DEPLOY_SSH_KEY
```

### 2. GitHub secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | contents of `~/.ssh/bubber_deploy` (the private one, `BEGIN`/`END` lines included) |
| `DEPLOY_HOST` | the server's hostname or IP |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KNOWN_HOSTS` | the `ssh-keyscan` output |

`DEPLOY_KNOWN_HOSTS` is what stops the deploy from trusting an impostor host. Don't
skip it in favour of `StrictHostKeyChecking=no`.

### 3. Server bootstrap (once, as `deploy`)

```bash
node --version          # need 18+; install via nodesource if missing
mkdir -p ~/apps/bubber-banking ~/staging/bubber-banking ~/.locks ~/logs
```

Then put the three secret files in `~/apps/bubber-banking/` — they live only here
and the deploy is written to never overwrite or delete them:

- `.env` — copy `.env.example` and fill it in
- `bubberbanking-207a3f8d45da.json` — the Google service-account key
- `tokens.json` — see below

`npm run link` serves a browser page, so run it **on your laptop**, then move the
resulting `tokens.json` up with the sftp access you already have:

```bash
sftp deploy@YOUR_HOST
> put tokens.json apps/bubber-banking/tokens.json
```

Same procedure any time you link a new bank.

### 4. First deploy

Push to `main` (or run the workflow manually from the Actions tab). Then verify by
hand once, before letting cron loose — this hits production Plaid and writes to the
real sheet:

```bash
cd ~/apps/bubber-banking && npm run sync
```

### 5. Cron

`crontab -e` as `deploy`:

```cron
0 */6 * * * flock -n /home/deploy/.locks/bubber-banking.lock -c 'cd /home/deploy/apps/bubber-banking && /usr/bin/npm run sync' >> /home/deploy/logs/sync.log 2>&1
```

The `flock` is not optional. It is the same lock `deploy/promote.sh` takes, and it's
what guarantees a deploy never swaps source files out from under a sync that's
mid-flight against real financial data. `-n` means "skip this run if one is already
going" rather than piling up.

## The one thing that can bite you

`rsync --delete` is what keeps the live tree clean, and the excludes in
[.deployignore](.deployignore) and [deploy/promote.sh](deploy/promote.sh) are what keep
your secrets alive through it. **Never add `--delete-excluded`** — that flag inverts
the protection and would wipe `.env` and `tokens.json`. Losing `tokens.json` means
re-linking every bank by hand.

---

# The PHP site

Same pattern, simpler: PHP is interpreted and the JS is static, so deploying is
just "put the files there." No build, no install, no restart.

In that repo, add `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-site
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure SSH
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${{ secrets.DEPLOY_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          printf '%s\n' "${{ secrets.DEPLOY_KNOWN_HOSTS }}" > ~/.ssh/known_hosts

      - name: Deploy
        run: |
          rsync -az --delete \
            --exclude-from=.deployignore \
            -e 'ssh -i ~/.ssh/id_ed25519' \
            ./ "${{ secrets.DEPLOY_USER }}@${{ secrets.DEPLOY_HOST }}:/var/www/YOUR_SITE/"
```

with a `.deployignore` alongside it:

```
.git
.github
node_modules
config.php
.env
uploads/
```

Reuse the same four secrets — you can add the same deploy key to both repos, or
generate a second one if you'd rather be able to revoke them independently.

Three site-specific things to sort out:

1. **Exclude anything user-generated or secret.** Any `config.php` with DB
   credentials, and any `uploads/` directory — those live on the server, and
   `--delete` will remove them if they aren't excluded.
2. **The `deploy` user needs write access to the docroot.** Usually
   `sudo chown -R deploy:www-data /var/www/YOUR_SITE`. Check with
   `sudo -u deploy touch /var/www/YOUR_SITE/.probe` before wiring up the workflow.
3. **If the JS needs building** (bundler, Tailwind, etc.), add `npm ci && npm run
   build` before the rsync step and make sure the output directory is *not* in
   `.deployignore`.
