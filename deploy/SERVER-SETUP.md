# One-time server setup

Everything here runs **once**, by hand, on the server. After it, every deploy is
`.github/workflows/deploy.yml` — push to `master` and it happens.

Substitute the real values throughout:

| Placeholder | Value |
| --- | --- |
| `DEPLOY_USER` | the SSH user GitHub Actions logs in as |
| `SERVER_HOST` | the VPC server's address |
| `SSH_PORT` | `44544` |

---

## 1. DNS

Neither hostname resolves yet. Both are needed, and one nginx file serves
both — `deploy/converter.alakbaroff.com.conf` — so add both records in
Cloudflare:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| `A` | `converter` | the VPC server's public IP | see below |
| `A` | `converterapi` | the VPC server's public IP | see below |

`converter` is the **frontend** (Next.js, proxied to `127.0.0.1:3011`) and
`converterapi` is the **API** (proxied to `127.0.0.1:3010`). They are separate
origins as far as a browser is concerned, which is the whole reason the API
answers CORS — see [`src/middleware/cors.ts`](../src/middleware/cors.ts).

Only the API host matters to this repository. The frontend is a separate
checkout with its own deploy; its server block is in the same file here
because the two share a host and a certificate, not because they share a
release.

**The proxy setting is not cosmetic — it decides which nginx line is right.**

- **DNS only** (grey cloud): traffic hits your nginx directly. Nothing further
  to do; the nginx config as written is correct.
- **Proxied** (orange cloud, like `nextudy.alakbaroff.com`): Cloudflare
  terminates TLS at its edge first. Two consequences:
  1. Uncomment the `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`
     line in [`converter.alakbaroff.com.conf`](converter.alakbaroff.com.conf).
     Without it, `TRUST_PROXY=1` makes Express trust the one hop and read the
     **Cloudflare edge IP** as the client — so the rate limiter buckets
     everyone at that edge together instead of per phone.
  2. Set Cloudflare's SSL mode to **Full (strict)**. The existing wildcard
     certificate is what satisfies the origin check. "Flexible" would put
     Cloudflare-to-origin traffic on plain HTTP and cause a redirect loop
     against the port-80 block below.

Confirm before going further — the deploy cannot work without it:

```bash
dig +short converterapi.alakbaroff.com
```

---

## 2. Prerequisites on the server

```bash
docker --version          # compose v2 needs `docker compose`, not `docker-compose`
docker compose version
git --version
curl --version

# The deploy user must be able to reach the Docker socket. If this fails with
# "permission denied", add the user to the group and log back in.
docker ps >/dev/null && echo "docker reachable"
```

---

## 3. Clone the repo

The backend checkout lives in a `backend/` subdirectory of the site directory,
so the frontend can sit alongside it in the parent rather than in a directory
named after the backend's hostname. The location is hard-coded in the workflow
and in this doc. If you change it, change it in
`.github/workflows/deploy.yml` too:

```bash
sudo mkdir -p /pool/www/converter.alakbaroff.com/backend
sudo chown "$USER":"$USER" /pool/www/converter.alakbaroff.com/backend

git clone <your-repo-url> /pool/www/converter.alakbaroff.com/backend
cd /pool/www/converter.alakbaroff.com/backend
git checkout master
```

The server then needs **pull** access to that remote for every future deploy —
a deploy key or a read-only token. Check it now rather than discovering it
inside a failed CI run:

```bash
git -C /pool/www/converter.alakbaroff.com/backend pull origin master
```

---

## 4. First deploy, by hand

Do this manually once. If anything about the server is wrong — missing docker,
a port already bound, a seccomp profile the daemon rejects — you want to see it
here, with the output in front of you, not in a red X on GitHub.

```bash
cd /pool/www/converter.alakbaroff.com/backend
docker compose up -d --build converterapi
docker compose logs -f converterapi
```

Watch for two JSON lines, in order. These are the boot gates:

```json
{"outcome":"preflight_ok","soffice":"...","fonts":{...}}
{"outcome":"warmup_ok","bytes":...}
```

No `preflight_ok` means soffice or the fonts are missing and the process
**exited** — it refuses to run rather than serving PDFs with wrong pagination.
That is the intended behaviour, and it is why this is a boot check.

Then:

```bash
curl -sS http://127.0.0.1:3010/health         # {"status":"ok"}

# The check that silently passes while producing wrong PDFs. Every line must
# resolve to a metric-compatible substitute, not to a fallback.
docker compose exec converterapi sh -c '
  for f in Calibri Cambria Arial "Times New Roman"; do
    printf "%s -> %s\n" "$f" "$(fc-match -f "%{family}" "$f")"
  done'
# Calibri -> Carlito
# Cambria -> Caladea
# Arial -> Liberation Sans
# Times New Roman -> Liberation Serif
```

---

## 5. nginx

Sites on this host live in `/etc/nginx/conf.d`, so this is a single-file drop —
no `sites-available` / `sites-enabled` symlink pair:

```bash
sudo cp /pool/www/converter.alakbaroff.com/backend/deploy/converter.alakbaroff.com.conf \
  /etc/nginx/conf.d/converter.alakbaroff.com.conf
sudo nginx -t && sudo systemctl reload nginx
```

**Keep the `.conf` extension.** nginx.conf includes that directory as
`include /etc/nginx/conf.d/*.conf`, so a file named without it is silently
skipped — `nginx -t` passes, the reload passes, and the site just does not
exist. Worth a glance to confirm the include is what you expect:

```bash
grep -r 'conf.d' /etc/nginx/nginx.conf
```

Then confirm TLS actually serves the hostname — `*.alakbaroff.com` must cover
it, and this is where you find out:

```bash
echo | openssl s_client -connect localhost:443 -servername converterapi.alakbaroff.com 2>/dev/null \
  | openssl x509 -noout -subject -dates
curl -sS https://converterapi.alakbaroff.com/health
```

---

## 6. GitHub secrets

Repository → Settings → Secrets and variables → Actions.

**These must be added to this repository specifically.** Actions secrets are
scoped per repository — the ones on your other project do **not** carry over,
even though the values are identical. The workflow will fail on a missing
`SSH_HOST` until they exist here.

| Secret | Value |
| --- | --- |
| `SSH_HOST` | `SERVER_HOST` |
| `SSH_USER` | `DEPLOY_USER` |
| `SSH_PASSWORD` | that user's password |

From the CLI, which prompts for the value without echoing it:

```bash
gh secret set SSH_HOST     --repo Samad126/converterapi
gh secret set SSH_USER     --repo Samad126/converterapi
gh secret set SSH_PASSWORD --repo Samad126/converterapi
```

The port `44544` and the deploy path are inline in the workflow rather than
secrets — they are not secret, and having them visible in the diff is worth
more than the indirection.

---

## 7. Verify the pipeline

Push to `master`, then confirm the whole loop:

```bash
curl -sS https://converterapi.alakbaroff.com/health
curl -sS -F "file=@report.docx" https://converterapi.alakbaroff.com/convert/pdf -o out.pdf
head -c 5 out.pdf        # %PDF-

# One conversion per document family, since each is a separate LibreOffice
# module and a container missing one fails only that family.
printf 'name,qty\nwidget,3\n' > sheet.csv
curl -sS -F "file=@sheet.csv" https://converterapi.alakbaroff.com/convert/xlsx -o out.xlsx
head -c 2 out.xlsx       # PK  (xlsx is a zip package)

curl -sS https://converterapi.alakbaroff.com/formats | head -c 120
```

The image targets need two binaries working together, so they are worth one
check of their own — a missing `poppler-utils` breaks nothing else:

```bash
curl -sS -F "file=@deck.pptx" https://converterapi.alakbaroff.com/convert/png -o slides.zip
unzip -l slides.zip      # slide-1.png  slide-2.png  ...
```

Note the deploy step's health poll and these `curl`s are not redundant. The
pipeline one asks *is the container alive on its loopback port*; these ask *is
the whole path — DNS, TLS, Cloudflare, nginx, proxy pass — actually serving*,
and whether every module the image needs is really in it. nginx can be down
while the container is perfectly healthy.
