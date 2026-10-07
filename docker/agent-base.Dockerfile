# OneCLI agent sandbox base — the OS surface of the hosted agent's computer
# (#1246 2a). Build context: repo root (`docker build -f docker/agent-base.Dockerfile .`),
# though nothing from the context enters this image: it is the Debian base,
# ONE apt layer, and the configuration, notes and build-time gates that depend
# only on those packages. docker/agent.Dockerfile stacks the app on top
# (`ARG AGENT_BASE_IMAGE`): the supervisor, its node_modules, the vendored
# jcode runtime and Nix release, the entrypoint, and `USER node`.
#
# Why two images: the apt layer is 600 MB compressed (73% of the agent image)
# and dominates a cold pull of it. Built here, it only changes when THIS file
# changes: a deployment can tag it by this file's hash, build it only when
# that tag is missing, and have the thin image pin it by digest. An app change
# then ships ~90 MB, and a host that already holds the base fetches only that.
#
# Rules for this file:
# - No COPY/ADD, no repo source, no app: the same bytes whatever commit builds
#   it, which is what makes the content-hash tag honest.
# - No USER, no CMD: the thin image owns the privilege drop and the command;
#   every RUN here needs root (package install, root-owned config, setuid
#   helpers, the gates that run as `node` through setpriv).
# - Any ENV added here must not already be set in docker/agent.Dockerfile
#   (scripts/agent-image.test.mjs pins the pair's ENV set).
# - Changing this file rebuilds the base, and every host running the image
#   may pull the full 600 MB once on its next update: do it deliberately.
# - The flip side: Debian security updates no longer arrive with every
#   deploy (the apt layer used to re-run on each cache miss). To take them,
#   bump the date below; nothing else reads it, it exists to change the hash.
#   apt-refresh: 2026-10-07
#
# Base is trixie-slim, NOT alpine: the jcode runtime the thin image vendors is
# a glibc binary needing glibc >= 2.39 and a dynamic libssl (the thin image's
# build proves the fit). The Node pin is shared with the thin image's build
# stages, so the app is built and run on the same Node and glibc.
FROM node:22.23.2-trixie-slim

# tini as PID 1: Node is not an init (signal handling differs, orphans are
# never reaped). Common tools are the agent's hands — every outbound request
# they make still exits through the gateway (§3.4).
# e2fsprogs + util-linux let a deployment that hands the sandbox a raw disk
# format and mount it as the home; inert under the Docker backend, where the
# home arrives as a pre-mounted volume.
# openssh-sftp-server + openssh-client serve the SSH front door:
# the terminator's relay execs /usr/lib/openssh/sftp-server for sftp and
# modern scp (≥9.0 rides sftp), and openssh-client provides the in-guest scp
# binary legacy `scp -O` targets — no daemon, no listener, the no-inbound
# posture is untouched (and agents get a useful ssh client of their own).
# podman + friends give the agent `docker run`-class work as ROOTLESS
# containers (the `docker` CLI itself arrives via podman-docker). Explicitly
# listed because they are only Recommends of podman: uidmap (setuid
# newuidmap/newgidmap — the user-namespace helpers), passt (pasta, the
# default rootless network) + slirp4netns (fallback), fuse-overlayfs
# (storage fallback; native overlay is the expected driver), aardvark-dns +
# iptables (netavark named networks / compose), catatonit (pod infra /
# --init). This is a capability of sandboxes that own a whole kernel (a
# per-sandbox VM); under the self-host Docker backend the same
# binaries are deliberately inert — the runner pins `no-new-privileges` +
# `CapDrop: ALL` on every sandbox (apps/runner/src/backend/docker/
# docker-backend.ts, pinned by its test), which neuters the setuid helpers.
# Never weaken those guards to chase this feature on a shared kernel; see
# /etc/containers/README.onecli (baked below) for the agent-visible note.
# python3 + python3-pip + python3-venv: the agent's second toolchain (node is
# the runtime; python is the lingua franca of one-off scripting). Debian
# marks the interpreter externally-managed (PEP 668), so pip refuses every
# install out of the box — PIP_BREAK_SYSTEM_PACKAGES (env, below) opens it,
# and as uid 1000 the system site-packages is unwritable anyway, so installs
# land in the user scheme under the DURABLE home (~/.local — bin dir shared
# with npm's global prefix). python3-venv also ships the offline pip wheel
# the durable-home gate (docker/agent.Dockerfile) installs from.
# nano + less: the SSH front door needs an editor and a pager (neither ships
# in slim, and --no-install-recommends keeps git from pulling less in);
# EDITOR/PAGER/LESS pin them below.
# The browser stack — chromium + chromium-sandbox + dbus-x11 + xvfb + fonts +
# ffmpeg: agents need browsers (decided 2026-09-09, plans/agent-owns-its-
# machine.md Tier 1). Playwright/Puppeteer from npm or pip drive the baked
# binary at /usr/bin/chromium; the alternative — the harness's own
# Firefox-extension browser tool — can never work in a headless guest and is
# disabled in the adapter. Four load-bearing details:
# - dbus-x11 is listed BEFORE chromium on purpose: chromium's dbus dependency
#   is satisfied by either dbus-x11 or dbus-user-session, and apt's default
#   pick (dbus-user-session) drags in systemd + systemd-sysv + libpam-systemd
#   — an init system this tini-PID-1 image must never carry. Naming dbus-x11
#   first makes the resolver take it instead (measured: 162 packages, no
#   systemd, vs 168 with). The gate below pins systemd's ABSENCE.
# - chromium-sandbox is the setuid helper (400 KB) that lets chromium's
#   DEFAULT sandbox run as uid 1000 where user namespaces are available —
#   a sandbox with its own kernel. Under the self-host Docker backend the same
#   `no-new-privileges` + `CapDrop: ALL` that neuter podman's setuid helpers
#   neuter this one too, and chromium must be told `--no-sandbox` (Playwright:
#   `chromiumSandbox: false`). Same law as podman: never weaken the Docker
#   guards for it; /etc/onecli/README.browser (baked below) tells the agent.
# - xvfb is the fallback display for the rare tool that refuses headless
#   mode; fonts-liberation + fonts-noto-color-emoji stop pages rendering as
#   empty boxes (slim ships no fonts at all).
# - ffmpeg is the video half: Playwright records .webm natively, and frames
#   or screenshots are stitched with ffmpeg. The gate proves VP9 encoding.
# - libnss3-tools is `certutil`, the only way to add a CA to the NSS shared
#   DB — and that DB is the ONLY trust store chromium reads on Linux
#   (chromium docs, linux/cert_management.md): it ignores SSL_CERT_FILE and
#   NODE_EXTRA_CA_CERTS. Every page here is re-signed by the gateway CA, so
#   without the import agent-entrypoint.sh does with this tool, every load
#   fails ERR_CERT_AUTHORITY_INVALID and the agent's escape by trial is
#   ignoreHTTPSErrors — verification off for every site (measured live,
#   2026-09-09). The gate below proves the import is what chromium
#   trusts, on a real handshake.
# gcc + g++ + make + libc6-dev + python3-dev: the C toolchain for native npm
# and pip modules (better-sqlite3, sharp, bcrypt, psycopg2, lxml…) that ship
# no prebuilt binary for this platform/runtime pairing and fall back to
# compiling at install time — without a compiler the install fails with a
# wall of gyp/gcc errors and the agent concludes the package is broken.
# Deliberately NOT build-essential: same compilers, minus 57 MB of dpkg-dev
# nothing here uses.
# procps + jq + zip + unzip + wget: the baseline any Linux box has and slim
# does not (`ps` in particular — an agent that cannot list its own processes
# burns turns on it).
# xz-utils: `.tar.xz` is the release format of half the tools an agent will
# fetch (Nix itself ships that way); slim has no xz.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini git curl ripgrep ca-certificates openssl e2fsprogs util-linux \
    openssh-sftp-server openssh-client \
    podman podman-docker uidmap passt slirp4netns fuse-overlayfs aardvark-dns catatonit iptables \
    python3 python3-pip python3-venv \
    nano less \
    dbus-x11 chromium chromium-sandbox xvfb fonts-liberation fonts-noto-color-emoji ffmpeg libnss3-tools \
    gcc g++ make libc6-dev python3-dev \
    procps jq zip unzip wget xz-utils \
  && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]

# Rootless-podman wiring. Four pieces, each load-bearing:
# - /etc/subuid + /etc/subgid: OVERWRITTEN, not appended — the base image
#   already allocates node:100000:65536, and a duplicate row makes newuidmap
#   fail with EINVAL (rootless dead). The range is a DURABLE-DATA FORMAT
#   CONTRACT: it is baked into the ownership of every file podman writes on
#   the persistent home volume, so changing it in a later image strands every
#   existing agent's container storage. Never "tidy" it; the gate below pins
#   the exact value.
# - containers.conf (root-owned): the no-systemd in-sandbox posture —
#   cgroupfs manager with cgroups disabled (limits come from the sandbox
#   itself; there is no journald for events/logs either), and
#   image_copy_tmp_dir="storage" so pull staging lands on the agent's own
#   home volume instead of /var/tmp on the ephemeral rootfs (which may sit on
#   storage shared with other sandboxes). base_hosts_file="" pins "copy the
#   sandbox's /etc/hosts into containers" — the only way a nested container
#   can resolve the gateway proxy host (sandboxes have no DNS egress).
# - registries.conf (root-owned): docker.io for unqualified names, so
#   `podman pull postgres` resolves.
# - storage.conf (node-owned, USER-level — rootless podman ignores the
#   graphroot in /etc/containers/storage.conf): graphroot on /workspace, the
#   durable home, so images/containers/volumes survive relaunch and
#   sleep. The file stays at its /home/node path ON PURPOSE, even now
#   that ~ lives at /workspace/.home: this copy is image-baked and
#   self-heals every boot (an agent-editable durable copy would not), and
#   the storage path inside it is a DURABLE-DATA FORMAT CONTRACT — moving
#   either strands every existing agent's container store.
#   CONTAINERS_STORAGE_CONF (env, below) pins the same file regardless of
#   where $HOME points.
RUN printf 'node:100000:65536\n' > /etc/subuid \
  && printf 'node:100000:65536\n' > /etc/subgid \
  # Debian installs these setuid already; assert-by-construction, not trust.
  && chmod u+s /usr/bin/newuidmap /usr/bin/newgidmap \
  && printf '%s\n' \
    '# OneCLI agent sandbox defaults — see README.onecli beside this file.' \
    '[containers]' \
    'log_driver = "k8s-file"' \
    'cgroups = "disabled"' \
    'base_hosts_file = ""' \
    '' \
    '[engine]' \
    'cgroup_manager = "cgroupfs"' \
    'events_logger = "file"' \
    'runtime = "crun"' \
    'image_copy_tmp_dir = "storage"' \
    > /etc/containers/containers.conf \
  && printf '%s\n' \
    '# OneCLI agent sandbox defaults — see README.onecli beside this file.' \
    'unqualified-search-registries = ["docker.io"]' \
    > /etc/containers/registries.conf \
  && install -d -o node -g node /home/node/.config /home/node/.config/containers \
  && printf '%s\n' \
    '# OneCLI agent sandbox defaults — see /etc/containers/README.onecli.' \
    '# Storage lives on /workspace (the durable home). This path is a' \
    '# durable-data format contract — never move it, even though ~ is now' \
    '# durable too (/workspace/.home): existing agents own storage HERE.' \
    '# rootless_storage_path is the load-bearing key — rootless podman IGNORES' \
    '# [storage] graphroot from the user config (that is the ROOTFUL path).' \
    '# graphroot is deliberately NOT set: pointing it at the durable home would' \
    '# aim a rootful invocation (e.g. a root kubectl exec, which inherits the' \
    '# global CONTAINERS_STORAGE_CONF) INTO the tenant rootless store, writing' \
    '# root-owned db/lock files that brick it. A rootful podman falls back to' \
    '# ephemeral /var/lib/containers, which is harmless. The store tree itself' \
    '# is pre-created node-owned by agent-entrypoint.sh (podman does not create' \
    '# <graphroot>/tmp before the first pull needs it).' \
    '[storage]' \
    'driver = "overlay"' \
    'rootless_storage_path = "/workspace/.local/share/containers/storage"' \
    > /home/node/.config/containers/storage.conf \
  && chown node:node /home/node/.config/containers/storage.conf \
  && printf '%s\n' \
    'OneCLI agent sandbox — nested containers (podman, plus the `docker` CLI shim).' \
    '' \
    'Rootless podman works on the hosted microVM substrate, where each sandbox' \
    'owns a whole kernel. Under the self-host Docker backend it is intentionally' \
    'disabled: the sandbox hardening (no-new-privileges, CapDrop ALL, and the' \
    'container runtime default seccomp profile) prevents the user-namespace' \
    'setup rootless containers need on a shared kernel. Do not weaken any of' \
    'those to work around it — the shared kernel is the tenant boundary there.' \
    '' \
    'Container storage lives under /workspace/.local/share/containers (the' \
    'durable home), so images, containers, and volumes survive sandbox restarts.' \
    'Running containers stop when the sandbox sleeps; `podman start` them again.' \
    'Outbound traffic from pulls follows the sandbox proxy; a nested container' \
    'inherits the proxy env (both HTTPS_PROXY/HTTP_PROXY and the lowercase' \
    'https_proxy/http_proxy), which carries a credential, so committing a' \
    'container bakes all four into the image config. Scrub ALL of them before' \
    'pushing anywhere, then confirm none survived:' \
    '  podman commit \' \
    '    --change "ENV HTTPS_PROXY=" --change "ENV HTTP_PROXY=" \' \
    '    --change "ENV https_proxy=" --change "ENV http_proxy=" <ctr> <image>' \
    '  podman inspect <image> | grep -i proxy   # must print nothing' \
    > /etc/containers/README.onecli
# The gate (same law as the jcode gate in docker/agent.Dockerfile): prove the
# runtime surface at build time, not at first agent boot. `podman info` is
# deliberately absent — it initializes storage/userns, which a build step
# must not.
RUN podman --version \
  && docker --version \
  # crun is pinned as the OCI runtime in containers.conf, but Debian satisfies
  # podman's dependency with `crun | runc` — prove the pinned one is actually
  # present, or every `podman run` dies at first use with the build still green.
  && crun --version \
  # The rootless network + storage helpers are Recommends-only (installed
  # explicitly above under --no-install-recommends); prove they landed.
  && command -v pasta \
  && command -v newuidmap \
  && command -v newgidmap \
  && test -u /usr/bin/newuidmap \
  && test -u /usr/bin/newgidmap \
  # catatonit doubles as the container init a remote backend may run in
  # place of the ENTRYPOINT's tini; its absence would fail every start there.
  && test -x /usr/bin/catatonit \
  && test -f /etc/containers/policy.json \
  && [ "$(grep -c '^node:' /etc/subuid)" -eq 1 ] \
  && [ "$(grep -c '^node:' /etc/subgid)" -eq 1 ] \
  && grep -qx 'node:100000:65536' /etc/subuid \
  && grep -qx 'node:100000:65536' /etc/subgid

# The browser note the machine fragment cites (one source, no drift — same
# pattern as /etc/containers/README.onecli). Root-owned: substrate facts,
# not agent preferences. The proxy paragraph is the load-bearing one,
# MEASURED 2026-09-09 against an authenticating test proxy: bare chromium
# reads the proxy HOST from HTTP_PROXY/HTTPS_PROXY but never the userinfo —
# it answers the 407 challenge with nothing and every page fails — while
# Playwright's launch({ proxy: { server, username, password } }) authenticates
# on the first challenge. The sandbox's proxy URL carries the agent's token
# as userinfo, so a browser started without that option reaches nothing.
RUN install -d /etc/onecli \
  && printf '%s\n' \
    'OneCLI agent sandbox — the browser stack.' \
    '' \
    'Chromium is installed at /usr/bin/chromium (headless-capable), with ffmpeg' \
    'for video and Xvfb as a fallback display. Drive it with Playwright or' \
    'Puppeteer from npm/pip and point them at the system binary:' \
    '  npm install -g playwright   # or: pip install --user playwright' \
    '' \
    'PROXY — READ THIS FIRST. Every request leaves this machine through the' \
    'sandbox proxy, whose URL (in HTTPS_PROXY) carries your access token as' \
    'user:password. Chromium reads the proxy HOST from that variable but never' \
    'the credentials, so a browser launched without them loads nothing. Hand' \
    'them to Playwright explicitly:' \
    '  const u = new URL(process.env.HTTPS_PROXY);' \
    '  const browser = await chromium.launch({' \
    '    executablePath: "/usr/bin/chromium",' \
    '    proxy: { server: `${u.protocol}//${u.host}`,' \
    '             username: decodeURIComponent(u.username),' \
    '             password: decodeURIComponent(u.password) },' \
    '  });' \
    '(Python: proxy={"server": ..., "username": ..., "password": ...}.)' \
    'Puppeteer has no proxy-credential launch option; use' \
    'page.authenticate({ username, password }) after --proxy-server=<host>.' \
    '' \
    'TLS: the proxy re-signs every HTTPS site with the sandbox CA. Chromium does' \
    'not read SSL_CERT_FILE; it trusts the NSS database at ~/.pki/nssdb, and the' \
    'sandbox CA is imported there at every boot, so pages load with normal' \
    'certificate checks. Never set ignoreHTTPSErrors or' \
    '--ignore-certificate-errors: that turns verification off for every site,' \
    'not just the proxy. If a page fails with ERR_CERT_AUTHORITY_INVALID, check' \
    'the import: `certutil -d sql:$HOME/.pki/nssdb -L` must list an' \
    'onecli-gateway-* entry with trust flags C,,.' \
    '' \
    'Playwright can also download its own Chromium build (`playwright install' \
    'chromium`); it lands under ~/.cache/ms-playwright on the durable home and' \
    'the shared libraries it needs are already here.' \
    '' \
    'Sandbox flag: on the hosted platform, Chromium'"'"'s own sandbox works as-is.' \
    'Under a self-hosted Docker deployment (no-new-privileges, CapDrop ALL) it' \
    'cannot start and you must pass --no-sandbox (Playwright:' \
    '`chromiumSandbox: false`). If launch fails with "No usable sandbox", that' \
    'is the reason. Never try to weaken the container'"'"'s own hardening for it.' \
    '' \
    'Video: Playwright records .webm natively (`recordVideo: { dir }`). It needs' \
    'its OWN small ffmpeg helper for that (~2 MB, separate from the system one):' \
    'run `npx playwright install ffmpeg` once; it lands on the durable home. The' \
    'system ffmpeg stitches screenshots or frames into video and converts formats' \
    '(`ffmpeg -framerate 10 -i f%03d.png out.webm`).' \
    > /etc/onecli/README.browser

# The browser/toolchain gate (same law as the podman and jcode gates: prove
# at build time, not at first agent boot).
RUN chromium --version \
  && command -v certutil \
  && ffmpeg -version | head -1 \
  && Xvfb -help >/dev/null 2>&1 \
  && fc-list | grep -qi liberation \
  && gcc --version | head -1 \
  && g++ --version | head -1 \
  && make --version | head -1 \
  && ps --version \
  && jq --version \
  && zip -v | head -1 \
  && unzip -v | head -1 \
  && wget --version | head -1 \
  # chromium-sandbox: the setuid helper must actually be setuid, or the
  # DEFAULT sandbox path dies as uid 1000 where the sandbox owns its kernel.
  && test -u /usr/lib/chromium/chrome-sandbox \
  # The systemd guard: the dbus-x11-before-chromium ordering above is what
  # keeps an init system out of this image, and a dependency change upstream
  # could silently undo it. Pin the absence, loudly.
  && ! dpkg-query -W systemd 2>/dev/null \
  && test -f /etc/onecli/README.browser \
  # Headless chromium REALLY renders as uid 1000: a screenshot of about:blank
  # must come out non-empty. --no-sandbox because the build environment has
  # no user namespaces (the default sandbox is proven live on the hosted
  # substrate, not here); --disable-gpu because there is no GPU anywhere
  # this image runs. Both are what a self-host Docker sandbox passes too.
  # HOME and --user-data-dir are pinned to a throwaway dir: setpriv keeps
  # root's HOME=/root, which uid 1000 cannot write, and chromium then dies
  # with "Failed to create headless user data directory" (found live on
  # this gate's first run). In production HOME is the durable ~ and this is
  # a non-issue; Playwright manages its own profile dir regardless.
  && setpriv --reuid node --regid node --init-groups sh -c ' \
       set -e; d=$(mktemp -d /tmp/gate.XXXXXX); cd "$d"; \
       HOME="$d" chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
         --user-data-dir="$d/profile" --screenshot="$d/shot.png" --window-size=640,480 \
         about:blank >/dev/null 2>&1; \
       test -s "$d/shot.png"; rm -rf "$d"' \
  # ffmpeg REALLY encodes the codec the browser-recording story needs (VP9 in
  # WebM — what Playwright produces and what Slack/web render inline).
  && setpriv --reuid node --regid node --init-groups sh -c ' \
       set -e; d=$(mktemp -d /tmp/gate.XXXXXX); cd "$d"; \
       ffmpeg -loglevel error -f lavfi -i testsrc=duration=1:size=64x64:rate=5 \
         -c:v libvpx-vp9 "$d/clip.webm"; \
       test -s "$d/clip.webm"; rm -rf "$d"' \
  # Chromium trusts a CA imported into ~/.pki/nssdb the way agent-entrypoint.sh
  # imports the gateway CA (certutil -A -t "C,,"), on a REAL TLS handshake: a
  # throwaway CA signs a localhost leaf, `openssl s_server` serves a page over
  # it, and headless chromium — no --ignore-certificate-errors — must dump
  # that page. The NEGATIVE half runs first and pins that the trust really
  # comes from the import: the same page from a profile without it must NOT
  # load. Both as uid 1000 with HOME on a throwaway dir, the production shape
  # (HOME on the durable home, the entrypoint importing as node). The
  # server-ready wait is bounded, not a fixed sleep.
  && setpriv --reuid node --regid node --init-groups sh -c ' \
       set -e; d=$(mktemp -d /tmp/gate.XXXXXX); cd "$d"; export HOME="$d"; \
       openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
         -subj "/CN=nss-gate-ca" -addext "basicConstraints=critical,CA:TRUE" \
         -keyout ca.key -out ca.pem 2>/dev/null; \
       openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
         -subj "/CN=localhost" -keyout leaf.key -out leaf.csr 2>/dev/null; \
       printf "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n" > leaf.ext; \
       openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
         -extfile leaf.ext -out leaf.pem 2>/dev/null; \
       echo "<title>nss-gate-ok</title>" > index.html; \
       openssl s_server -accept 127.0.0.1:8443 -cert leaf.pem -key leaf.key -WWW -quiet >/dev/null 2>&1 & \
       srv=$!; i=0; until openssl s_client -connect 127.0.0.1:8443 -CAfile ca.pem </dev/null >/dev/null 2>&1; do \
         i=$((i+1)); [ "$i" -lt 50 ] || { echo "nss gate: s_server never came up" >&2; exit 1; }; sleep 0.1; done; \
       load() { chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
                  --user-data-dir="$d/$1" --dump-dom https://localhost:8443/index.html 2>/dev/null \
                | grep -q nss-gate-ok; }; \
       if load p0; then echo "nss gate: chromium loaded an UNTRUSTED page" >&2; exit 1; fi; \
       mkdir -p "$HOME/.pki/nssdb"; certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password; \
       certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n onecli-gateway-nss-gate -i ca.pem; \
       if ! load p1; then echo "nss gate: chromium did not trust the NSS-imported CA" >&2; exit 1; fi; \
       kill "$srv" 2>/dev/null || true; cd /; rm -rf "$d"'

# The durable POSIX home: ~ = /workspace/.home, ON the home volume. Three
# pieces:
# - usermod: passwd is where the Docker substrate derives HOME from (runc
#   fills HOME from the passwd entry when the env lacks it — spawn AND
#   exec); agent-entrypoint.sh, and any deployment that boots the sandbox
#   itself, export the same literal (AGENT_POSIX_HOME).
# - the profile.d drop-in: SSH login shells — Debian's /etc/profile RESETS
#   PATH, so the entrypoint's export cannot survive `bash -l`/`sh -lc`.
#   APPENDED, never prepended: a tenant-writable dir ahead of the system
#   dirs would let a planted binary shadow git/node/curl for every session.
#   POSIX-only syntax — `sh -lc` sessions run dash, which sources
#   /etc/profile.d too.
# - the directory itself is created at CONTAINER runtime by
#   agent-entrypoint.sh as uid 1000 — deliberately NOT here: root must never
#   create tenant-mount dirs, and content baked under /workspace forks the
#   substrates (Docker seeds named volumes from image content; the hosted
#   block mount shadows it).
RUN usermod -d /workspace/.home node \
  && printf '%s\n' \
    '# OneCLI agent sandbox: the durable tool bin (npm -g, pip --user).' \
    '# Appended, never prepended - image binaries must win name lookups.' \
    'case ":$PATH:" in' \
    '  *":/workspace/.home/.local/bin:"*) ;;' \
    '  *) PATH="$PATH:/workspace/.home/.local/bin" ;;' \
    'esac' \
    '' \
    '# Nix (Tier 1.5), when the agent has installed it. Never SOURCE the' \
    '# agent-writable profile hook from a system file: set the one thing nix' \
    '# needs (its bin dir, APPENDED - image binaries win name lookups) and' \
    '# point it at the gateway CA (the hook would pick the system bundle).' \
    '# Mirrors agent-entrypoint.sh; POSIX-only (dash sources this too).' \
    'if [ -n "${HOME:-}" ]; then' \
    '  _onecli_nix="$HOME/.local/state/nix/profile"' \
    '  [ -e "$_onecli_nix" ] || _onecli_nix="$HOME/.nix-profile"' \
    '  if [ -e "$_onecli_nix/bin/nix" ]; then' \
    '    case ":$PATH:" in' \
    '      *":$_onecli_nix/bin:"*) ;;' \
    '      *) PATH="$PATH:$_onecli_nix/bin" ;;' \
    '    esac' \
    '    export PATH' \
    '    if [ -n "${SSL_CERT_FILE:-}" ]; then export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"; fi' \
    '  fi' \
    '  unset _onecli_nix' \
    'fi' \
    > /etc/profile.d/onecli-path.sh

# The Nix note the machine fragment cites (one source, no drift — same
# pattern as README.browser / README.onecli). Root-owned.
RUN printf '%s\n' \
    'OneCLI agent sandbox — Nix, the durable install path.' \
    '' \
    'For a program that should survive restarts and is not on npm or pip, use' \
    'Nix. It installs as your own user, needs no root, and its store lives on' \
    'your durable disk (/workspace/.nix, bind-mounted at /nix every boot).' \
    '' \
    '  onecli-nix-install                 # once per agent, ~5 s, offline' \
    '  nix profile add nixpkgs#ripgrep    # then install anything: search.nixos.org' \
    '  nix profile list / remove / upgrade' \
    '' \
    'New shells have nix on PATH automatically. In the shell you ran the' \
    'installer from, first:  . ~/.nix-profile/etc/profile.d/nix.sh &&' \
    'export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"   (the profile hook points Nix at' \
    'the system CA bundle, which lacks the gateway CA; the export fixes that).' \
    '' \
    'Downloads come from cache.nixos.org through the sandbox proxy like every' \
    'other tool. Your settings are in ~/.config/nix/nix.conf (flakes on,' \
    'build sandbox off — binary-cache installs are unaffected).' \
    '' \
    'Hosted agents only: on a self-hosted Docker deployment nothing mounts /nix,' \
    'and onecli-nix-install says so. Use npm, pip, or a container image there.' \
    > /etc/onecli/README.nix

# Rootless podman's runtime state (locks, conmon sockets, the optional API
# socket) — EPHEMERAL by design: its disappearance across a relaunch is how
# podman detects a "reboot" and resets stale container state. The dir is baked
# into the image so it exists on every fresh rootfs regardless of what spawns
# the process (supervisor, docker exec, an SSH session); a deployment may
# additionally mount a tmpfs over it. Nothing else
# in the image reads XDG_RUNTIME_DIR (no systemd/logind here).
ENV XDG_RUNTIME_DIR=/tmp/onecli-xdg-run
RUN install -d -m 0700 -o node -g node /tmp/onecli-xdg-run
# Belt-and-braces for HOME-less invocations: pin the rootless storage config
# by env too — losing it would land storage on the ephemeral rootfs silently.
ENV CONTAINERS_STORAGE_CONF=/home/node/.config/containers/storage.conf

# `npm -g` and `pip --user` share ONE durable root: both bin dirs unify at
# /workspace/.home/.local/bin — the single PATH entry the entrypoint and
# /etc/profile.d/onecli-path.sh append. ENV (not entrypoint-only) so
# docker-exec / remote-exec sessions inherit it too. Deliberately NO `ENV
# HOME` here: it would poison later build-stage RUNs and fork the
# substrates (Docker seeds named volumes from image content); HOME comes
# from passwd (usermod above), the deployment's boot, and the entrypoint.
ENV NPM_CONFIG_PREFIX=/workspace/.home/.local
# PEP 668 pin — without it every `pip install` on this base refuses. Safe
# here: no system component uses python, and as uid 1000 the system
# site-packages is unwritable, so pip lands in the user scheme under the
# durable ~ (proven by the durable-home gate in docker/agent.Dockerfile).
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV EDITOR=nano
ENV PAGER=less
# -F quit-if-one-screen, -R pass colors through, -X no termcap init:
# behaves for SSH humans and non-interactive reads alike (no hung pager in
# a harness shell).
ENV LESS=FRX
