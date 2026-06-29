#!/bin/sh
# Publishes an extra mDNS name so the menu is also reachable at
#   http://thehollow.local/
# in addition to the machine's own <hostname>.local. Keeps running (the systemd
# unit restarts it and starts it at boot) and advertises the NUC's LAN IP.

# Prefer the source IP of the default route (skips docker/VM bridge addresses);
# fall back to the first address from `hostname -I`.
IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -z "$IP" ] && IP="$(hostname -I | awk '{print $1}')"
exec avahi-publish -a -R thehollow.local "$IP"
