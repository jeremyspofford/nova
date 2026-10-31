#!/bin/sh
# The no-Kubernetes tripwire (M10e; docs/plans/M10-orchestration.md, "With the K3s driver off"). Runs a
# command with stand-in kubectl, helm, flux and k3s first on PATH: each one records that it was
# called and fails. KUBECONFIG is unset. If any of them was called, the run fails, whatever the
# command's own result, and says what was called. Nova must work fully with no Kubernetes anywhere;
# only the K3s driver's own tests (M10j) may put their fakes on PATH, ahead of these.
# Usage: scripts/tripwire.sh <command> [args…]      (npm test and the UI gate run through it)
set -eu
dir=$(mktemp -d "${TMPDIR:-/tmp}/nova-tripwire-XXXXXX")
trap 'rm -rf "$dir"' EXIT INT TERM
mkdir -p "$dir/bin"
log="$dir/calls.log"
: > "$log"
for tool in kubectl helm flux k3s; do
  cat > "$dir/bin/$tool" <<EOF
#!/bin/sh
printf '%s %s\n' '$tool' "\$*" >> '$log'
echo "no-Kubernetes tripwire: $tool was called (\$*). Nova runs with no Kubernetes anywhere." >&2
exit 97
EOF
  chmod 755 "$dir/bin/$tool"
done
unset KUBECONFIG
PATH="$dir/bin:$PATH"
NOVA_K8S_TRIPWIRE="$dir/bin"
NOVA_K8S_TRIPWIRE_LOG="$log"
export PATH NOVA_K8S_TRIPWIRE NOVA_K8S_TRIPWIRE_LOG
echo "no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)"
set +e
"$@"
code=$?
set -e
if [ -s "$log" ]; then
  echo "no-Kubernetes tripwire: FIRED. Called during the run:" >&2
  sed 's/^/  /' "$log" >&2
  exit 1
fi
echo "no-Kubernetes tripwire: never fired"
exit "$code"
