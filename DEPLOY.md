# Hosting The Hollow on your NUC (Linux)

Goal: an always-on menu that anyone on your home network can open at
`http://<your-nuc>/`. We use [Caddy](https://caddyserver.com/) — a single,
reliable web server that auto-starts on boot.

These steps assume Debian/Ubuntu (the most common NUC setup). Run them in a
terminal on the NUC.

## 1. Put the files on the NUC

Pick a folder Caddy can read — `/srv/the_hollow` is a good home:

```bash
sudo mkdir -p /srv/the_hollow
# Copy the repo into it. Examples (use whichever fits):
sudo git clone <your-repo-url> /srv/the_hollow          # from git, or…
# scp -r the_hallow/ youruser@nuc:/tmp/ && sudo cp -r /tmp/the_hallow/. /srv/the_hollow/
```

## 2. Install Caddy

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Installing the package automatically enables `caddy.service` to start on every
boot — that's your "always-on."

## 3. Point Caddy at the menu

```bash
sudo cp /srv/the_hollow/deploy/Caddyfile /etc/caddy/Caddyfile
# Caddy only needs to READ these files. Keep them owned by YOU (so `git pull`
# works without sudo) and just make them world-readable:
sudo chown -R "$(logname)":"$(logname)" /srv/the_hollow
sudo chmod -R a+rX /srv/the_hollow
sudo systemctl reload caddy
systemctl status caddy --no-pager      # should say "active (running)"
```

If a firewall is on, open the port: `sudo ufw allow 80/tcp`.

## 4. Find the address and visit it

```bash
hostname -I        # prints the LAN IP, e.g. 192.168.1.50
```

From any phone or laptop on the network, open `http://192.168.1.50/`.

### Nicer: a name instead of an IP

mDNS (Avahi) makes the NUC answer to `<hostname>.local` automatically — that's
where `nucrunner.local` comes from. Install it if it isn't already:

```bash
sudo apt install -y avahi-daemon
hostname           # whatever this prints is your <hostname>.local
```

Tip: set a **DHCP reservation** in your router so the NUC's IP never changes.

## Give it a friendly name: `thehollow.local`

You don't have to rename the machine. Publish an extra mDNS name that points at
the NUC, so **both** `nucrunner.local` and `thehollow.local` work. The repo ships
a tiny service for this in `deploy/`.

```bash
sudo apt install -y avahi-daemon avahi-utils
sudo cp /srv/the_hollow/deploy/thehollow-mdns.sh /usr/local/bin/thehollow-mdns.sh
sudo chmod +x /usr/local/bin/thehollow-mdns.sh
sudo cp /srv/the_hollow/deploy/thehollow-mdns.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thehollow-mdns.service
systemctl status thehollow-mdns.service --no-pager   # should be "active (running)"
```

Now open **`http://thehollow.local/`** from any device. No Caddy change is needed —
the Caddyfile listens on port 80 for every hostname.

**Simpler alternative — rename the machine.** If this NUC is dedicated to the
menu, just rename it and skip the alias service entirely:

```bash
sudo hostnamectl set-hostname thehollow      # then http://thehollow.local/
```

(Downside: `nucrunner.local`, and anything else pointing at that name like SSH,
stops working.)

### Heads up on `.local` support

Apple devices, Windows, and most laptops resolve `.local` names fine. Some older
Android phones don't support mDNS `.local` at all — on those, the NUC's IP (or a
custom DNS entry in your router) is the fallback.

## Updating the menu later

1. Edit `cocktails.js` (add/remove drinks — see `README.md`).
2. Get the changed file onto the server: run `git pull` in `/srv/the_hollow`
   **as your normal user (no `sudo`)**, or copy the file over.
3. Refresh the page. No restart needed — `cocktails.js` is served with no-cache,
   so edits appear immediately.

Only if you change the **Caddyfile** do you need: `sudo systemctl reload caddy`.

If the ordering API code (`server/`) changes, restart it after pulling:
`sudo systemctl restart thehollow-api` (and `cd server && npm install` if its
dependencies changed). `index.html` is static — a browser refresh is enough.

## Troubleshooting

- **Blank page / no drinks:** check the logs with `journalctl -u caddy -e`.
  Confirm `/srv/the_hollow/index.html` exists and is world-readable
  (`sudo chmod -R a+rX /srv/the_hollow`).
- **`git pull` says "dubious ownership":** the folder is owned by a different
  user than the one running git. Hand ownership back to yourself, then pull
  without sudo:
  `sudo chown -R "$(logname)":"$(logname)" /srv/the_hollow && sudo chmod -R a+rX /srv/the_hollow`.
  (Quick-but-messier alternative: `sudo git config --global --add safe.directory /srv/the_hollow` and keep using `sudo git pull`.)
- **Port 80 already in use:** change `:80` to `:8080` in the Caddyfile, reload,
  and visit `http://<ip>:8080/`.
- **Want HTTPS on the LAN?** Optional and a bit more involved (browsers distrust
  self-signed certs by name); plain HTTP is fine for a home network. Ask if you
  want to set this up.

## The live ordering board (the API)

This powers **The Pass** — guests adding drinks to The Rail, the bartender firing
Rounds, and live status. It's a small Node service backed by SQLite, kept always-on
by systemd, with Caddy proxying `/api/*` to it. Run these on the NUC after a `git pull`.

1. Install Node system-wide (via NodeSource — don't use `nvm` for a service):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

2. Install the service's dependency:

```bash
cd /srv/the_hollow/server
npm install --omit=dev
# If it fails to fetch a prebuilt binary, add build tools and retry:
#   sudo apt install -y build-essential python3 && npm install --omit=dev
```

3. Install + start the service (it auto-creates `/srv/the_hollow/data` for the db):

```bash
# If your login isn't jrhernan15, edit the User=/Group= lines first:
#   sudoedit /srv/the_hollow/deploy/thehollow-api.service
sudo cp /srv/the_hollow/deploy/thehollow-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thehollow-api.service
systemctl status thehollow-api.service --no-pager     # should be active (running)
```

4. Update Caddy to proxy the API, then reload:

```bash
sudo cp /srv/the_hollow/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

5. Smoke test:

```bash
curl -s http://localhost/api/health    # {"ok":true}
curl -s http://localhost/api/state     # {"rail":[],"rounds":[]}
```

Notes:

- The database lives at `/srv/the_hollow/data/hollow.db` (gitignored). Wipe the
  board for a fresh party with `curl -X POST http://localhost/api/reset` (a "Reset
  the Pass" button comes in a later phase).
- Logs: `journalctl -u thehollow-api -e`.
- The service binds to `127.0.0.1` only; guests reach it through Caddy, never directly.

## Why it must be served (not double-clicked)

This version loads its data and React as browser modules/scripts that the
`file://` protocol blocks for security. Serving over `http://` (what Caddy does)
makes everything load correctly. React itself is vendored locally in
`assets/vendor/`, so the page does **not** depend on the internet once the NUC
is serving it — it works even if your WAN is down.
