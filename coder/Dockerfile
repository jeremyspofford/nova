# The coder sidecar runs a coding agent that WRITES FILES AND RUNS COMMANDS.
# It is the most dangerous container in the stack, so it is the most confined:
# no host mounts, no Docker socket, no database, no Nova secrets. Phase 0
# established that the agent's own permission layer cannot be relied on as a
# boundary (see broker.py), which makes this Dockerfile the boundary.
FROM node:22-slim

# git is the deliverable's format — the agent edits a private clone and the
# broker turns that into a branch and a diff. python3 runs the broker.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pinned, not floating. The adapter shipped five releases in the ten days
# before this was written and ACP v2 is in draft; an unpinned agent could
# negotiate a protocol this broker does not speak. acp.py refuses that
# outright rather than half-working, and the pin is how we choose when to
# take that change.
RUN npm install --no-audit --no-fund @agentclientprotocol/claude-agent-acp@0.64.0

COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# The test runners the session allow-list permits. They must exist HERE,
# because installing is refused at the adjudicator (`pip` is not an allowed
# command — a registry install executes arbitrary setup code). Measured
# 2026-07-31: with the allow-list shipped but pytest absent, the agent wrote a
# test, tried `pip3 install pytest`, was correctly denied, and could not verify
# its own fix. An allow-list naming a tool the image lacks is a promise the
# container cannot keep.
RUN pip3 install --no-cache-dir --break-system-packages pytest ruff

COPY acp.py broker.py ./

# Non-root. /workspaces must exist IN THE IMAGE and be owned by this uid:
# Docker seeds a fresh named volume from the image path it mounts over, so
# this is what makes the clone volume writable without a chown at runtime —
# which a read-only rootfs and a non-root user could not perform anyway.
RUN useradd -u 1000 -m coder || true \
 && mkdir -p /workspaces && chown 1000:1000 /workspaces
USER 1000:1000
ENV HOME=/home/coder

EXPOSE 8110
CMD ["python3", "-m", "uvicorn", "broker:app", "--host", "0.0.0.0", "--port", "8110"]
