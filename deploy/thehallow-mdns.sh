#!/bin/sh
# Publishes an extra mDNS name so the menu is also reachable at
#   http://thehallow.local/
# in addition to the machine's own <hostname>.local. It keeps running (the
# systemd unit restarts it and starts it at boot) and advertises the NUC's
# current primary IP address.
IP="$(hostname -I | awk '{print $1}')"
exec avahi-publish-address thehallow.local "$IP"
