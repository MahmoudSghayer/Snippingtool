#!/usr/bin/env bash
# gen-datastore-certs.sh — mint the in-stack TLS material for Postgres and
# Redis.
#
# Why this exists: config/env.ts refuses to boot the API under
# NODE_ENV=production unless DATABASE_URL carries sslmode=require and
# REDIS_URL uses the rediss:// scheme (docs/threat-model.md §3.7/§3.8,
# "network sniffing between the API and the DB/Redis"). On the single-VM
# compose topology both datastores are containers on a private bridge, so
# there is no managed provider handing us a certificate — we are both ends
# of the connection, so we issue our own CA and let the API verify against
# it properly rather than skipping verification.
#
# Output (infra/certs/, git-ignored — regenerate, never commit):
#   ca.crt / ca.key            the private CA
#   postgres.crt / .key        server cert, CN+SAN `postgres`
#   redis.crt / .key           server cert, CN+SAN `redis`
#
# The SANs are the compose *service names*, which are exactly the hostnames
# the API dials, so verification succeeds without disabling hostname checks.
#
# Ownership is set for the uid each image runs as (postgres=70, redis=999):
# both servers refuse to start if their key is group/world readable, and the
# bind mount carries host ownership straight into the container.
set -euo pipefail

cert_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
days="${CERT_DAYS:-3650}"

mkdir -p "$cert_dir"
cd "$cert_dir"

if [[ -f ca.crt && -f ca.key && "${FORCE:-0}" != "1" ]]; then
  echo "[certs] $cert_dir already populated; set FORCE=1 to reissue" >&2
  exit 0
fi

echo "[certs] issuing CA"
openssl req -x509 -newkey rsa:4096 -sha256 -days "$days" -nodes \
  -keyout ca.key -out ca.crt \
  -subj "/CN=Sniper's Ledger datastore CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

issue() {
  local name="$1" uid="$2"
  echo "[certs] issuing $name (SAN: DNS:$name)"
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "$name.key" -out "$name.csr" -subj "/CN=$name" 2>/dev/null
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$name.crt" -days "$days" -sha256 \
    -extfile <(printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$name") 2>/dev/null
  rm -f "$name.csr"
  chown "$uid:$uid" "$name.key" "$name.crt"
  chmod 600 "$name.key"
  chmod 644 "$name.crt"
}

issue postgres 70
issue redis 999

# The CA cert is public material and is read by the API (uid 10001), the
# redis exporter and the backup container, so it stays world-readable; the
# CA *key* is only ever needed by this script.
chmod 600 ca.key
chmod 644 ca.crt
rm -f ca.srl

echo "[certs] done — $cert_dir"
ls -l "$cert_dir"
