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
sudo chown -R caddy:caddy /srv/the_hollow
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

## Give it a friendly name: `thehallow.local`

You don't have to rename the machine. Publish an extra mDNS name that points at
the NUC, so **both** `nucrunner.local` and `thehallow.local` work. The repo ships
a tiny service for this in `deploy/`.

```bash
sudo apt install -y avahi-daemon avahi-utils
sudo cp /srv/the_hollow/deploy/thehallow-mdns.sh /usr/local/bin/thehallow-mdns.sh
sudo chmod +x /usr/local/bin/thehallow-mdns.sh
sudo cp /srv/the_hollow/deploy/thehallow-mdns.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thehallow-mdns.service
systemctl status thehallow-mdns.service --no-pager   # should be "active (running)"
```

Now open **`http://thehallow.local/`** from any device. No Caddy change is needed —
the Caddyfile listens on port 80 for every hostname.

**Simpler alternative — rename the machine.** If this NUC is dedicated to the
menu, just rename it and skip the alias service entirely:

```bash
sudo hostnamectl set-hostname thehallow      # then http://thehallow.local/
```

(Downside: `nucrunner.local`, and anything else pointing at that name like SSH,
stops working.)

### Heads up on `.local` support

Apple devices, Windows, and most laptops resolve `.local` names fine. Some older
Android phones don't support mDNS `.local` at all — on those, the NUC's IP (or a
custom DNS entry in your router) is the fallback.

## Updating the menu later

1. Edit `cocktails.js` (add/remove drinks — see `README.md`).
2. Get the changed file onto the server: `git pull` in `/srv/the_hollow`, or copy
   the file over.
3. Refresh the page. No restart needed — `cocktails.js` is served with no-cache,
   so edits appear immediately.

Only if you change the **Caddyfile** do you need: `sudo systemctl reload caddy`.

## Troubleshooting

- **Blank page / no drinks:** check the logs with `journalctl -u caddy -e`.
  Confirm `/srv/the_hollow/index.html` exists and the `caddy` user can read the
  folder (`sudo chown -R caddy:caddy /srv/the_hollow`).
- **Port 80 already in use:** change `:80` to `:8080` in the Caddyfile, reload,
  and visit `http://<ip>:8080/`.
- **Want HTTPS on the LAN?** Optional and a bit more involved (browsers distrust
  self-signed certs by name); plain HTTP is fine for a home network. Ask if you
  want to set this up.

## Why it must be served (not double-clicked)

This version loads its data and React as browser modules/scripts that the
`file://` protocol blocks for security. Serving over `http://` (what Caddy does)
makes everything load correctly. React itself is vendored locally in
`assets/vendor/`, so the page does **not** depend on the internet once the NUC
is serving it — it works even if your WAN is down.
