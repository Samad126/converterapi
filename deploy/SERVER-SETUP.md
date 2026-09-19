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

`converter.alakbaroff.com` does not resolve yet. Add a record in Cloudflare:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| `A` | `converter` | the VPC server's public IP | see below |

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
dig +short converter.alakbaroff.com
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

The checkout location is hard-coded in the workflow and in this doc. If you
change it, change it in `.github/workflows/deploy.yml` too:

```bash
sudo mkdir -p /pool/www/converter.alakbaroff.com
sudo chown "$USER":"$USER" /pool/www/converter.alakbaroff.com

git clone <your-repo-url> /pool/www/converter.alakbaroff.com
cd /pool/www/converter.alakbaroff.com
git checkout master
```

The server then needs **pull** access to that remote for every future deploy —
a deploy key or a read-only token. Check it now rather than discovering it
inside a failed CI run:

```bash
git -C /pool/www/converter.alakbaroff.com pull origin master
```

---

## 4. First deploy, by hand

Do this manually once. If anything about the server is wrong — missing docker,
a port already bound, a seccomp profile the daemon rejects — you want to see it
here, with the output in front of you, not in a red X on GitHub.

```bash
cd /pool/www/converter.alakbaroff.com
docker compose up -d --build converter
docker compose logs -f converter
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
curl -sS http://127.0.0.1:3001/health         # {"status":"ok"}

# The check that silently passes while producing wrong PDFs. Every line must
# resolve to a metric-compatible substitute, not to a fallback.
docker compose exec converter sh -c '
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
sudo cp /pool/www/converter.alakbaroff.com/deploy/converter.alakbaroff.com.conf \
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
echo | openssl s_client -connect localhost:443 -servername converter.alakbaroff.com 2>/dev/null \
  | openssl x509 -noout -subject -dates
curl -sS https://converter.alakbaroff.com/health
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
gh secret set SSH_HOST     --repo Samad126/file-converter
gh secret set SSH_USER     --repo Samad126/file-converter
gh secret set SSH_PASSWORD --repo Samad126/file-converter
```

The port `44544` and the deploy path are inline in the workflow rather than
secrets — they are not secret, and having them visible in the diff is worth
more than the indirection.

---

## 7. Verify the pipeline

Push to `master`, then confirm the whole loop:

```bash
curl -sS https://converter.alakbaroff.com/health
curl -sS -F "file=@report.docx" https://converter.alakbaroff.com/convert -o out.pdf
head -c 5 out.pdf        # %PDF-
```

Note the deploy step's health poll and this `curl` are not redundant. The
pipeline one asks *is the container alive on its loopback port*; this one asks
*is the whole path — DNS, TLS, Cloudflare, nginx, proxy pass — actually
serving*. nginx can be down while the container is perfectly healthy.
