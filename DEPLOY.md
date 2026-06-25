# Deploy TradeScope on a Hostinger KVM VPS (Ubuntu)

Your KVM 4 VPS is a full Linux server — perfect for running this 24/7.
On the VPS, Claude (best-trade + smart news) is **off** (no Max login there);
everything else — live charts, prices, scoring, F&O, backtest — works fully.

Replace `YOUR_VPS_IP` with your VPS's IP (from Hostinger hPanel).

---

## 1. Connect to the VPS

From your PC (PowerShell or any terminal):

```bash
ssh root@YOUR_VPS_IP
```

Enter the VPS password (set in Hostinger hPanel → VPS → Settings).

## 2. Install Node.js 20 + pm2 (one time)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git
npm install -g pm2
node --version    # should print v20.x
```

## 3. Get the project onto the VPS

**Option A — via GitHub (recommended):** push this folder to a GitHub repo from your
PC, then on the VPS:

```bash
cd /opt
git clone https://github.com/<your-username>/<your-repo>.git tradescope
cd tradescope
```

**Option B — direct upload:** from your PC, copy the folder up with scp
(exclude node_modules), then SSH in and `cd` to it:

```bash
# run on your PC, in the project's parent folder
scp -r "alerts for sagar bhai and nipani bhabhi" root@YOUR_VPS_IP:/opt/tradescope
```

## 4. Install dependencies

```bash
cd /opt/tradescope
npm install --omit=dev
```

## 4b. Create the .env (the Finnhub key is NOT in the repo, by design)

```bash
cat > .env <<'EOF'
FINNHUB_KEY=PASTE_YOUR_FINNHUB_KEY_HERE
PORT=3000
ENABLE_CLAUDE=0
EOF
```

Use the same Finnhub key from your PC's local `.env` (free key from
https://finnhub.io). Without this, the app still runs but live ticks are disabled.

## 5. Start it with pm2 (keeps it alive + auto-start on reboot)

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints back, once
pm2 logs tradescope   # watch it boot (Ctrl+C to exit logs)
```

You should see: `US Market Alerts running at http://localhost:3000`,
`Finnhub WS connected`, and `Alerts refreshed`.

## 6. Open the port + visit it

```bash
ufw allow 3000
ufw allow OpenSSH
ufw --force enable
```

Now open in your browser:  **http://YOUR_VPS_IP:3000**  🎉

---

## 7. (Optional, proper) Clean URL with a domain + free HTTPS

Skip if `http://IP:3000` is fine for you. For a real `https://yourdomain.com`:

```bash
apt-get install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/tradescope`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/tradescope /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d yourdomain.com        # free SSL
```

(Point your domain's A record to `YOUR_VPS_IP` in your DNS first.)

---

## Updating later

```bash
cd /opt/tradescope
git pull            # if using GitHub
npm install --omit=dev
pm2 restart tradescope
```

## Want Claude (best-trade + smart news) on the VPS?

The Max-subscription CLI can't run on the VPS. To enable Claude there you'd add a
paid Anthropic **API key** (~$1–3/mo for this usage) and wire an API-based path —
ask and I'll add it. Until then it runs great with keyword sentiment.
