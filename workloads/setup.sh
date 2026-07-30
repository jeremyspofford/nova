#!/usr/bin/env bash
# Build Nova's runtime from nothing, reproducibly.
#
# The cluster is DISPOSABLE and this script is why. Every control lives in the
# manifests beside it, so "recreate the cluster" is one command rather than an
# archaeology exercise — and a control that only ever existed because somebody
# typed it at a terminal is not a control, it is a thing that will be missing
# next time.
#
#   ./workloads/setup.sh            # create + configure + credential
#   ./workloads/setup.sh --recreate # delete first
#
# Safe to re-run: everything is apply-shaped.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=nova
# FIXED api port, so the URL the backend is configured with survives a cluster
# recreate. k3d picks a random one otherwise and every rebuild silently breaks
# the backend's connection.
API_PORT=6550
CALICO_VER=v3.32.1
# Nova's pods live here. NOT Calico's 192.168.0.0/16 default, which collides
# with the operator's LAN (192.168.0.0/24) and would hand pods addresses on the
# network the host routes through.
POD_CIDR=10.42.0.0/16
CRED_DIR=data/runtime
K3D=${K3D:-$(command -v k3d || echo "$HOME/.local/bin/k3d")}

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

if [[ "${1:-}" == "--recreate" ]]; then
  say "deleting the existing cluster"
  "$K3D" cluster delete "$CLUSTER" || true
fi

if ! "$K3D" cluster list "$CLUSTER" >/dev/null 2>&1; then
  say "creating the cluster"
  # --no-lb, traefik and servicelb disabled: nothing here may depend on
  #   k3d-specific pieces, because they do not exist on the real k3s nodes this
  #   has to move to.
  # --flannel-backend=none --disable-network-policy: k3s's own kube-router
  #   applies NetworkPolicy AFTER a pod is running, which left a ~15s window a
  #   short-lived Job walked straight through. Calico attaches policy during
  #   CNI ADD instead. See README.
  # --tls-san host.docker.internal: so the backend can VERIFY TLS rather than
  #   skip it. Without this the served cert has no name the backend can reach
  #   it by, and the only options are a docker-network coupling or verify=off.
  "$K3D" cluster create "$CLUSTER" \
    --servers 1 --agents 0 --no-lb \
    --api-port "127.0.0.1:${API_PORT}" \
    --k3s-arg "--disable=traefik@server:0" \
    --k3s-arg "--disable=servicelb@server:0" \
    --k3s-arg "--flannel-backend=none@server:0" \
    --k3s-arg "--disable-network-policy@server:0" \
    --k3s-arg "--cluster-cidr=${POD_CIDR}@server:0" \
    --k3s-arg "--tls-san=host.docker.internal@server:0" \
    --timeout 300s
else
  echo "cluster '$CLUSTER' already exists — leaving it alone"
fi

say "installing Calico ${CALICO_VER}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -sL -o "$TMP/calico.yaml" \
  "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VER}/manifests/calico.yaml"
# Pin the pool. Left commented out it defaults to 192.168.0.0/16 — the LAN.
python3 - "$TMP/calico.yaml" "$POD_CIDR" <<'PY'
import re, sys
path, cidr = sys.argv[1], sys.argv[2]
s = open(path).read()
pat = re.compile(r'#\s*- name: CALICO_IPV4POOL_CIDR\s*\n\s*#\s*value: "[^"]+"')
if not pat.search(s):
    sys.exit("could not find CALICO_IPV4POOL_CIDR to pin — refusing to install "
             "with the 192.168.0.0/16 default")
open(path, "w").write(pat.sub(
    f'- name: CALICO_IPV4POOL_CIDR\n              value: "{cidr}"', s, count=1))
print(f"  pinned CALICO_IPV4POOL_CIDR to {cidr}")
PY
kubectl apply -f "$TMP/calico.yaml" >/dev/null
kubectl -n kube-system rollout status ds/calico-node --timeout=300s

say "applying the boundary"
kubectl apply -f workloads/

say "issuing the ServiceAccount credential"
# k8s 1.24+ stopped auto-creating SA tokens; the typed Secret is the supported
# way to get one that does not expire in an hour. Bound to nova-deployer, so it
# carries EXACTLY the Role in rbac.yaml — the backend authenticating as this
# cannot exceed the boundary even if its own code is wrong.
kubectl apply -f - >/dev/null <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: nova-deployer-token
  namespace: nova-workloads
  annotations:
    kubernetes.io/service-account.name: nova-deployer
type: kubernetes.io/service-account-token
EOF
for _ in $(seq 30); do
  kubectl -n nova-workloads get secret nova-deployer-token \
    -o jsonpath='{.data.token}' 2>/dev/null | grep -q . && break
  sleep 1
done

mkdir -p "$CRED_DIR"
kubectl -n nova-workloads get secret nova-deployer-token \
  -o jsonpath='{.data.token}' | base64 -d > "$CRED_DIR/k8s-token"
kubectl -n nova-workloads get secret nova-deployer-token \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > "$CRED_DIR/k8s-ca.crt"
chmod 600 "$CRED_DIR/k8s-token"
echo "  wrote $CRED_DIR/k8s-token and k8s-ca.crt (gitignored)"

say "done"
cat <<EOF
  API for the backend : https://host.docker.internal:${API_PORT}
  namespace           : nova-workloads
  credential          : ${CRED_DIR}/k8s-token  (ServiceAccount nova-deployer)

Verify the boundary with:  docker compose exec backend python tests/../../workloads/verify.py
EOF
