#!/usr/bin/env bash
# Lumina VPS manager. Credentials belong in the application's settings, never here.
set -Eeuo pipefail
umask 077

REPOSITORY='WXD2233/lumina-gallery'
INSTALL_ROOT='/opt/lumina-gallery'
PROJECT='lumina-gallery'
MARKER_TEXT='lumina-gallery-managed-v1'
TMP_DIR=''
UPGRADE_ACTIVE=0
OLD_STOPPED=0
INSTALL_ACTIVE=0
OLD_RELEASE=''
OLD_IMAGE=''
ROLLBACK_DIR=''
SNAPSHOT_READY=0
ROLLBACK_FAILED=0
DOMAIN=''
EMAIL=''
VERSION=''
PURGE=0

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
version_valid() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*)?$ && ${#1} -le 100 ]]; }
domain_valid() {
  [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ && ${#1} -le 253 ]]
}
email_valid() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ && ${#1} -le 254 ]]; }

usage() {
  cat <<'USAGE'
拾光图库 VPS 管理器（Linux，需 root）
  lumina install --domain gallery.example.com --email admin@example.com [--version 1.0.0]
  lumina upgrade [--version 1.0.0]
  lumina uninstall                 停止并卸载服务，保留图库和设置
  lumina uninstall --purge-data    经本机输入确认后删除全部图库和设置
  lumina start | status | logs | setup-admin | menu
不带参数进入菜单。安装需要域名 DNS 指向本机，且 TCP 80/443、UDP 443 可用。
USAGE
}

managed() {
  [[ -f "$INSTALL_ROOT/.managed" && ! -L "$INSTALL_ROOT/.managed" ]] || die '未找到此管理器的安装标记，拒绝操作。'
  [[ "$(cat "$INSTALL_ROOT/.managed")" == "$MARKER_TEXT" ]] || die '安装标记不匹配。'
}

safe_root() {
  [[ "$INSTALL_ROOT" == '/opt/lumina-gallery' && ! -L "$INSTALL_ROOT" ]] || die '安装目录不安全。'
  if [[ -e "$INSTALL_ROOT" ]]; then
    [[ "$(realpath -e "$INSTALL_ROOT")" == "$INSTALL_ROOT" ]] || die '安装目录经过符号链接，拒绝操作。'
    for name in data config releases upgrade-backups; do
      [[ ! -L "$INSTALL_ROOT/$name" ]] || die "$name 目录不允许是符号链接。"
    done
  fi
}

safe_child() {
  local path="$1" resolved
  [[ -e "$path" && ! -L "$path" ]] || die "受管路径缺失或为符号链接：$path"
  resolved="$(realpath -e "$path")"
  [[ "$resolved" == "$INSTALL_ROOT/"* && "$resolved" != "$INSTALL_ROOT/" ]] || die '路径超出安装目录。'
}

current_release() {
  local path
  [[ -L "$INSTALL_ROOT/current" ]] || die '当前版本链接不存在；请运行 install 完成安装。'
  path="$(realpath -e "$INSTALL_ROOT/current")"
  [[ "$path" == "$INSTALL_ROOT/releases/"* ]] || die '当前版本链接超出版本目录。'
  version_valid "${path##*/}" || die '当前版本目录名无效。'
  [[ -f "$path/deploy/compose.yaml" ]] || die '当前版本缺少部署文件。'
  [[ -f "$path/.managed" && ! -L "$path/.managed" && "$(cat "$path/.managed")" == "$MARKER_TEXT" ]] || die '当前版本不是本管理器创建。'
  printf '%s\n' "$path"
}

compose_at() {
  local release="$1" env_file="$2"; shift 2
  validate_env "$release" "$env_file" || return 1
  env -u LUMINA_IMAGE -u LUMINA_DOMAIN -u ACME_EMAIL -u LUMINA_DATA_DIR -u LUMINA_CONFIG_DIR -u LUMINA_PROXY_SUBNET -u LUMINA_PROXY_IP \
    docker compose --project-name "$PROJECT" --env-file "$env_file" --project-directory "$release/deploy" -f "$release/deploy/compose.yaml" "$@"
}
compose() {
  local release
  release="$(current_release)" || return 1
  compose_at "$release" "$INSTALL_ROOT/config/deploy.env" "$@"
}

# Read an allowlist of literal values. Never source or eval a downloaded/config file.
env_value() {
  python3 - "$1" "$2" <<'PY'
import pathlib, sys
allowed = {'LUMINA_IMAGE', 'LUMINA_DOMAIN', 'ACME_EMAIL', 'LUMINA_DATA_DIR', 'LUMINA_CONFIG_DIR', 'LUMINA_PROXY_SUBNET', 'LUMINA_PROXY_IP'}
key = sys.argv[2]
if key not in allowed:
    raise SystemExit('Unsupported configuration key')
rows = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line or line.startswith('#'): continue
    name, separator, value = line.partition('=')
    if not separator or name not in allowed or name in rows or any(c in value for c in '\x00\r\n$`"\'\\'):
        raise SystemExit('Unsafe deployment configuration')
    rows[name] = value
if key not in rows:
    raise SystemExit('Missing deployment configuration: ' + key)
print(rows[key])
PY
}

validate_env() {
  python3 - "$1" "$2" "$INSTALL_ROOT" <<'PY'
import ipaddress, pathlib, re, sys
release, filename, root = sys.argv[1:]
allowed = {'LUMINA_IMAGE', 'LUMINA_DOMAIN', 'ACME_EMAIL', 'LUMINA_DATA_DIR', 'LUMINA_CONFIG_DIR', 'LUMINA_PROXY_SUBNET', 'LUMINA_PROXY_IP'}
rows = {}
for line in pathlib.Path(filename).read_text().splitlines():
    if not line or line.startswith('#'): continue
    key, sep, value = line.partition('=')
    if not sep or key not in allowed or key in rows or any(c in value for c in '\x00\r\n$`"\'\\'):
        raise SystemExit('Unsafe deployment configuration')
    rows[key] = value
if set(rows) != allowed: raise SystemExit('Incomplete deployment configuration')
if rows['LUMINA_IMAGE'] != 'lumina-gallery:' + pathlib.Path(release).name: raise SystemExit('Image does not match managed release')
if rows['LUMINA_DATA_DIR'] != root + '/data' or rows['LUMINA_CONFIG_DIR'] != root + '/config':
    raise SystemExit('Data/config paths must remain inside the managed install')
if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?', rows['LUMINA_DOMAIN']) or len(rows['LUMINA_DOMAIN']) > 253:
    raise SystemExit('Invalid domain')
if not re.fullmatch(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}', rows['ACME_EMAIL']) or len(rows['ACME_EMAIL']) > 254:
    raise SystemExit('Invalid ACME email')
try:
    network = ipaddress.ip_network(rows['LUMINA_PROXY_SUBNET'], strict=True)
    proxy = ipaddress.ip_address(rows['LUMINA_PROXY_IP'])
    valid = network.version == 4 and network.prefixlen == 29 and network.subnet_of(ipaddress.ip_network('172.30.0.0/16')) and proxy == network.network_address + 2
except ValueError:
    valid = False
if not valid: raise SystemExit('Proxy must use address .2 of a dedicated 172.30.x.x/29 network')
PY
}

newer_version() {
  python3 - "$1" "$2" <<'PY'
import sys
def parts(version):
    core, separator, pre = version.partition('-')
    return tuple(map(int, core.split('.'))), pre.split('.') if separator else None
old_core, old_pre = parts(sys.argv[1]); new_core, new_pre = parts(sys.argv[2])
if new_core != old_core: raise SystemExit(0 if new_core > old_core else 1)
if old_pre is None: raise SystemExit(1)
if new_pre is None: raise SystemExit(0)
for old, new in zip(old_pre, new_pre):
    if old == new: continue
    if old.isdigit() and new.isdigit(): newer = int(new) > int(old)
    elif old.isdigit() != new.isdigit(): newer = old.isdigit()
    else: newer = new > old
    raise SystemExit(0 if newer else 1)
raise SystemExit(0 if len(new_pre) > len(old_pre) else 1)
PY
}

choose_proxy_network() {
  local ids
  ids="$(docker network ls -q)"
  [[ "$ids" =~ ^[a-f0-9[:space:]]+$ ]] || die 'Docker 网络列表格式无效。'
  # Docker IDs contain no shell metacharacters. Intentional word splitting passes IDs as arguments.
  docker network inspect $ids > "$TMP_DIR/networks.json"
  python3 - "$TMP_DIR/networks.json" <<'PY'
import ipaddress, json, sys
used = []
for network in json.load(open(sys.argv[1])):
    for config in network.get('IPAM', {}).get('Config') or []:
        try: used.append(ipaddress.ip_network(config.get('Subnet', ''), strict=False))
        except ValueError: pass
for third in list(range(91, 255)) + list(range(0, 91)) + [255]:
    candidate = ipaddress.ip_network(f'172.30.{third}.0/29')
    if not any(n.version == 4 and n.overlaps(candidate) for n in used):
        print(candidate, candidate.network_address + 2)
        break
else:
    raise SystemExit('No available dedicated 172.30.x.0/29 network; please adjust existing Docker networks')
PY
}

write_env() {
  local destination="$1" image="$2" subnet="${3:-172.30.91.0/29}" proxy_ip="${4:-172.30.91.2}"
  domain_valid "$DOMAIN" && email_valid "$EMAIL" || die '域名或邮箱格式无效。'
  [[ "$image" =~ ^lumina-gallery:[A-Za-z0-9.-]+$ ]] || die '镜像名称无效。'
  [[ "$subnet" =~ ^[0-9./]+$ && "$proxy_ip" =~ ^[0-9.]+$ ]] || die '代理网络配置无效。'
  printf 'LUMINA_IMAGE=%s\nLUMINA_DOMAIN=%s\nACME_EMAIL=%s\nLUMINA_DATA_DIR=%s/data\nLUMINA_CONFIG_DIR=%s/config\nLUMINA_PROXY_SUBNET=%s\nLUMINA_PROXY_IP=%s\n' \
    "$image" "$DOMAIN" "$EMAIL" "$INSTALL_ROOT" "$INSTALL_ROOT" "$subnet" "$proxy_ip" > "$destination"
  chmod 600 "$destination"
}

curl_get() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 1800 --retry 2 "$@"; }

ensure_dependencies() {
  local missing=0
  for cmd in curl python3 tar flock realpath sha256sum ss; do command -v "$cmd" >/dev/null || missing=1; done
  if (( missing )); then
    command -v apt-get >/dev/null || die '请先安装 curl、python3、tar、util-linux、coreutils、iproute2。'
    say '安装管理器所需的系统工具……'
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl python3 tar util-linux coreutils iproute2
  fi
}

ensure_docker() {
  if command -v docker >/dev/null; then
    docker info >/dev/null 2>&1 || die 'Docker 未启动或当前用户无法访问；请先启动 Docker。'
    docker compose version >/dev/null 2>&1 || die '请先安装 Docker Compose v2 插件（docker-compose-plugin）。'
    return
  fi
  command -v apt-get >/dev/null || die '此系统请先安装 Docker Engine 和 Docker Compose v2，然后重新运行。'
  local distro codename arch conflict
  read -r distro codename < <(python3 - <<'PY'
import pathlib, shlex
rows = {}
for line in pathlib.Path('/etc/os-release').read_text().splitlines():
    key, sep, raw = line.partition('=')
    if sep:
        values = shlex.split(raw)
        rows[key] = values[0] if values else ''
print(rows.get('ID', ''), rows.get('VERSION_CODENAME', ''))
PY
  )
  [[ "$distro" == ubuntu || "$distro" == debian ]] || die '自动安装 Docker 仅支持 Debian/Ubuntu；其他系统请先自行安装 Docker。'
  [[ "$codename" =~ ^[a-z][a-z0-9-]+$ ]] || die '无法识别系统版本。'
  for conflict in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$conflict" 2>/dev/null | grep -q 'install ok installed'; then
      die "检测到已有 $conflict，请按 Docker 官方文档处理冲突后安装；管理器不会卸载其他软件。"
    fi
  done
  say '通过 Docker 官方签名 APT 仓库安装 Docker Engine 和 Compose v2……'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl_get "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch="$(dpkg --print-architecture)"
  [[ "$arch" == amd64 || "$arch" == arm64 ]] || die '仅提供 amd64/arm64 VPS 安装支持。'
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$arch" "$distro" "$codename" > /etc/apt/sources.list.d/lumina-docker.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker info >/dev/null && docker compose version >/dev/null || die 'Docker 安装后未能启动。'
}

prepare_root() {
  safe_root
  if [[ -d "$INSTALL_ROOT" && ! -f "$INSTALL_ROOT/.managed" ]] && [[ -n "$(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    die '安装目录已有非本管理器创建的文件，拒绝覆盖。'
  fi
  mkdir -p "$INSTALL_ROOT"/{config,data,releases,upgrade-backups}
  if [[ -f "$INSTALL_ROOT/.managed" ]]; then managed; else printf '%s\n' "$MARKER_TEXT" > "$INSTALL_ROOT/.managed"; fi
  chmod 700 "$INSTALL_ROOT" "$INSTALL_ROOT/config" "$INSTALL_ROOT/releases" "$INSTALL_ROOT/upgrade-backups"
  # The application image runs as UID 1000. Never recursively change an existing gallery.
  if [[ -z "$(find "$INSTALL_ROOT/data" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    chown 1000:1000 "$INSTALL_ROOT/data"
    chmod 700 "$INSTALL_ROOT/data"
  fi
}

check_ports() {
  local listeners
  listeners="$(ss -H -lnt '( sport = :80 or sport = :443 )'; ss -H -lnu '( sport = :443 )')"
  [[ -z "$listeners" ]] || die '80/443 端口已被其他服务占用。请先为图库安排独立 VPS 或自行配置反向代理；不会停止或覆盖现有服务。'
}

check_space() {
  local requested="$1" path="${2:-$INSTALL_ROOT}" free
  free="$(df -PB1 "$path" | awk 'NR==2 {print $4}')"
  [[ "$free" =~ ^[0-9]+$ ]] || die '无法读取剩余存储空间。'
  (( free >= requested )) || die "剩余空间不足（需要至少 $((requested / 1024 / 1024)) MiB，剩余 $((free / 1024 / 1024)) MiB）；不会删除图库或自动备份腾空间。"
}

release_metadata() {
  local url="https://api.github.com/repos/$REPOSITORY/releases/latest"
  if [[ -n "$VERSION" ]]; then
    version_valid "$VERSION" || die '版本格式应为 1.0.0 或 1.0.0-beta.1。'
    url="https://api.github.com/repos/$REPOSITORY/releases/tags/v$VERSION"
  fi
  curl_get -H 'Accept: application/vnd.github+json' "$url" -o "$TMP_DIR/release.json"
  VERSION="$(python3 - "$TMP_DIR/release.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
if r.get('draft'): raise SystemExit('Draft releases are not installable')
tag = r.get('tag_name', '')
if not tag.startswith('v'): raise SystemExit('Release tag must begin with v')
print(tag[1:])
PY
  )"
  version_valid "$VERSION" || die 'GitHub 发布版本格式无效。'
}

asset_size() {
  python3 - "$TMP_DIR/release.json" "$1" <<'PY'
import json, sys
assets = [a for a in json.load(open(sys.argv[1])).get('assets', []) if a.get('name') == sys.argv[2]]
if len(assets) > 1: raise SystemExit('Duplicate release asset')
print(int(assets[0]['size']) if assets else 0)
PY
}

verify_asset() {
  python3 - "$TMP_DIR/SHA256SUMS" "$TMP_DIR/$1" "$1" <<'PY'
import hashlib, pathlib, re, sys
manifest, path, name = sys.argv[1:]
found = []
for line in pathlib.Path(manifest).read_text().splitlines():
    match = re.fullmatch(r'([a-fA-F0-9]{64})\s+\*?([^\s]+)', line)
    if match and match[2] == name: found.append(match[1].lower())
if len(found) != 1: raise SystemExit('Missing or duplicate checksum for ' + name)
h = hashlib.sha256()
with open(path, 'rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
if h.hexdigest() != found[0]: raise SystemExit('Checksum mismatch for ' + name)
PY
}

download_asset() {
  local filename="$1"
  curl_get "https://github.com/$REPOSITORY/releases/download/v$VERSION/$filename" -o "$TMP_DIR/$filename"
  verify_asset "$filename" || die "发布文件校验失败：$filename；已停止。"
}

fetch_release() {
  release_metadata
  local source="lumina-gallery-$VERSION-source.tar.gz" image archive arch source_size image_size
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die '只支持 amd64/arm64 CPU。' ;; esac
  archive="lumina-gallery-$VERSION-linux-$arch.tar.gz"
  source_size="$(asset_size "$source")"
  image_size="$(asset_size "$archive")"
  (( source_size > 0 && source_size <= 1073741824 )) || die '此版本缺少有效的源码发布包。'
  (( image_size <= 4294967296 )) || die '镜像发布包过大，拒绝下载。'
  check_space "$((1073741824 + source_size * 3 + image_size * 4))"
  curl_get "https://github.com/$REPOSITORY/releases/download/v$VERSION/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS"
  download_asset "$source"
  # Do not let archive paths, links or device files escape the staging directory.
  python3 - "$TMP_DIR/$source" "$TMP_DIR/source" "lumina-gallery-$VERSION" <<'PY'
import pathlib, tarfile, sys
archive, destination, prefix = sys.argv[1:]
target = pathlib.Path(destination)
target.mkdir(mode=0o700)
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    if len(members) > 30000 or sum(m.size for m in members) > 1073741824:
        raise SystemExit('Source archive exceeds limits')
    seen = set()
    for m in members:
        p = pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or '\\' in m.name or not p.parts or p.parts[0] != prefix or not (m.isfile() or m.isdir()) or m.name in seen:
            raise SystemExit('Unsafe source archive member')
        seen.add(m.name)
    tar.extractall(target, members=members)
PY
  local staged="$TMP_DIR/source/lumina-gallery-$VERSION" final="$INSTALL_ROOT/releases/$VERSION"
  [[ -f "$staged/deploy/compose.yaml" && -f "$staged/scripts/lumina.sh" ]] || die '源码发布包缺少部署文件。'
  # Same-version reinstalls reuse the checksum-verified payload rather than trusting old files.
  if [[ -e "$final" ]]; then
    safe_child "$final"
    [[ -f "$final/.managed" && ! -L "$final/.managed" && "$(cat "$final/.managed")" == "$MARKER_TEXT" ]] || die '版本目录不是本管理器创建，拒绝覆盖。'
    if [[ -L "$INSTALL_ROOT/current" && "$(realpath -e "$INSTALL_ROOT/current")" == "$final" ]]; then
      die '此版本已经安装；需要升级请选择另一个已发布版本。'
    fi
    rm -rf -- "$final"
  fi
  mv -- "$staged" "$final"
  printf '%s\n' "$MARKER_TEXT" > "$final/.managed"
  image="lumina-gallery:$VERSION"
  if (( image_size > 0 )); then
    say "下载并校验 $arch 预构建镜像……"
    download_asset "$archive"
    docker load --input "$TMP_DIR/$archive"
    docker image inspect "$image" >/dev/null || die "发布包中没有预期镜像 $image。"
  else
    say '此版本没有匹配 CPU 的预构建镜像；使用已校验的源码在本机构建（需要更多内存和空间）。'
    docker build --tag "$image" "$final"
  fi
  local image_arch
  image_arch="$(docker image inspect --format '{{.Architecture}}' "$image")"
  [[ "$image_arch" == "$arch" ]] || die '镜像 CPU 架构不匹配。'
  printf '%s\n' "$VERSION" >> "$INSTALL_ROOT/config/managed-images.list"
  say "发布包已校验：$VERSION"
}

point_current() {
  local release="$1"
  safe_child "$release"
  if [[ -L "$INSTALL_ROOT/.current-next" ]]; then
    [[ "$(readlink "$INSTALL_ROOT/.current-next")" == releases/* ]] || die '临时版本链接不安全。'
    rm -- "$INSTALL_ROOT/.current-next"
  fi
  [[ ! -e "$INSTALL_ROOT/.current-next" ]] || die '临时版本路径被其他文件占用。'
  ln -s "releases/${release##*/}" "$INSTALL_ROOT/.current-next"
  mv -Tf -- "$INSTALL_ROOT/.current-next" "$INSTALL_ROOT/current"
}

wait_healthy() {
  local needs_caddy="${1:-yes}" attempt id status running
  for ((attempt=0; attempt<60; attempt++)); do
    id="$(compose ps -q lumina 2>/dev/null)"
    status='missing'
    if [[ -n "$id" ]]; then status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"; fi
    if [[ "$status" == healthy ]]; then
      [[ "$needs_caddy" == no ]] && return 0
      id="$(compose ps -q caddy 2>/dev/null)"
      running="$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null || true)"
      [[ "$running" == true ]] && return 0
    fi
    sleep 2
  done
  return 1
}

verify_https() {
  local attempt
  say '等待域名 HTTPS 证书（域名 DNS 必须指向本 VPS，防火墙开放 80/443）……'
  for ((attempt=0; attempt<30; attempt++)); do
    if curl --fail --silent --show-error --proto '=https' --resolve "$DOMAIN:443:127.0.0.1" --connect-timeout 3 --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  say '服务已启动，但暂未通过域名 HTTPS 检查。请检查 DNS、VPS 防火墙和 Caddy 日志；请勿使用明文 HTTP 登录。'
  return 1
}

checkpoint_backup() {
  local db="$INSTALL_ROOT/data/gallery.db" stamp size
  [[ -f "$db" && ! -L "$db" ]] || die '找不到有效的图库数据库，拒绝升级。'
  size="$(stat -c '%s' "$db")"
  if [[ -f "$db-wal" ]]; then size="$((size + $(stat -c '%s' "$db-wal")))"; fi
  check_space "$((size * 3 + 268435456))"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
  ROLLBACK_DIR="$INSTALL_ROOT/upgrade-backups/$stamp"
  mkdir -m 700 "$ROLLBACK_DIR"
  printf '%s\n' "$MARKER_TEXT" > "$ROLLBACK_DIR/.managed"
  cp -- "$INSTALL_ROOT/config/deploy.env" "$ROLLBACK_DIR/deploy.env"
  docker run --rm --network none --user 0 --entrypoint node \
    --mount "type=bind,src=$INSTALL_ROOT/data,dst=/data" --mount "type=bind,src=$ROLLBACK_DIR,dst=/backup" \
    "$OLD_IMAGE" --input-type=module -e 'import { DatabaseSync, backup } from "node:sqlite"; import { chmodSync } from "node:fs"; const db = new DatabaseSync("/data/gallery.db"); try { const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); if (result.busy) throw new Error("Database is still in use"); await backup(db, "/backup/gallery.db"); chmodSync("/backup/gallery.db", 0o600); } finally { db.close(); }'
  [[ -s "$ROLLBACK_DIR/gallery.db" ]] || die '升级前数据库快照失败。'
  printf 'complete\n' > "$ROLLBACK_DIR/.complete"
  SNAPSHOT_READY=1
}

rollback() {
  say '升级未完成，停止新服务并恢复升级前数据库和版本……' >&2
  UPGRADE_ACTIVE=0
  # A failure may happen between switching the env and the current symlink.
  # Use the known candidate pair to stop this project, independent of that switch.
  compose_at "$INSTALL_ROOT/releases/$VERSION" "$TMP_DIR/candidate.env" stop -t 60 caddy lumina >/dev/null 2>&1 || return 1
  docker run --rm --network none --user 0 --entrypoint node \
    --mount "type=bind,src=$INSTALL_ROOT/data,dst=/data" --mount "type=bind,src=$ROLLBACK_DIR,dst=/backup,readonly" \
    "$OLD_IMAGE" --input-type=module -e 'import { copyFileSync, renameSync, rmSync, chmodSync, chownSync, constants } from "node:fs"; import { randomUUID } from "node:crypto"; const temporary = "/data/.gallery-restore-" + randomUUID(); let created = false; try { copyFileSync("/backup/gallery.db", temporary, constants.COPYFILE_EXCL); created = true; chmodSync(temporary, 0o600); chownSync(temporary, 1000, 1000); rmSync("/data/gallery.db-wal", {force:true}); rmSync("/data/gallery.db-shm", {force:true}); renameSync(temporary, "/data/gallery.db"); created = false; } finally { if (created) rmSync(temporary, {force:true}); }' || return 1
  cp -- "$ROLLBACK_DIR/deploy.env" "$INSTALL_ROOT/config/deploy.env.next" || return 1
  mv -f -- "$INSTALL_ROOT/config/deploy.env.next" "$INSTALL_ROOT/config/deploy.env" || return 1
  point_current "$OLD_RELEASE" || return 1
  compose up -d --no-build --no-deps lumina || return 1
  wait_healthy no || return 1
  compose up -d --no-build caddy || return 1
  wait_healthy || return 1
  OLD_STOPPED=0
  say '已恢复原版本；升级快照保留用于检查。' >&2
}

cleanup_owned_history() {
  # Only our named, marked directories are eligible. Keep current plus one previous release.
  python3 - "$INSTALL_ROOT" "$OLD_RELEASE" <<'PY'
import pathlib, re, shutil, sys
root = pathlib.Path(sys.argv[1])
current = (root / 'current').resolve(strict=True)
previous = pathlib.Path(sys.argv[2]).resolve() if sys.argv[2] else None
releases = []
for p in (root / 'releases').iterdir():
    if p.is_symlink() or not p.is_dir() or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?', p.name): continue
    if p.resolve().parent != (root / 'releases').resolve(): continue
    marker = p / '.managed'
    if marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != 'lumina-gallery-managed-v1': continue
    releases.append(p)
keep = {current}
if previous and previous.exists() and previous != current: keep.add(previous)
if len(keep) < 2:
    for p in sorted(releases, key=lambda p:p.stat().st_mtime, reverse=True):
        if p.resolve() not in keep: keep.add(p.resolve()); break
for p in releases:
    if p.resolve() not in keep: shutil.rmtree(p)
backups = []
for p in (root / 'upgrade-backups').iterdir():
    if p.is_symlink() or not p.is_dir() or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}', p.name): continue
    marker = p / '.managed'
    complete = p / '.complete'
    if not marker.is_symlink() and marker.is_file() and marker.read_text().strip() == 'lumina-gallery-managed-v1' and complete.is_file() and not complete.is_symlink(): backups.append(p)
for p in sorted(backups, key=lambda p:p.name, reverse=True)[2:]: shutil.rmtree(p)
PY
  # Remove only obsolete project image tags, never prune globally or touch other containers.
  local tag keep_version previous_version
  keep_version="$(basename "$(current_release)")"
  previous_version="${OLD_RELEASE##*/}"
  while IFS= read -r tag; do
    version_valid "$tag" || continue
    [[ "$tag" == "$keep_version" || "$tag" == "$previous_version" ]] && continue
    [[ -d "$INSTALL_ROOT/releases/$tag" ]] && continue
    docker image rm "lumina-gallery:$tag" >/dev/null 2>&1 || true
  done < <(sort -u "$INSTALL_ROOT/config/managed-images.list")
  # The ledger itself is bounded by the retained owned release directories.
  : > "$INSTALL_ROOT/config/managed-images.list.next"
  local directory retained
  for directory in "$INSTALL_ROOT/releases/"*; do
    [[ -d "$directory" && ! -L "$directory" ]] || continue
    retained="${directory##*/}"
    version_valid "$retained" || continue
    [[ -f "$directory/.managed" && ! -L "$directory/.managed" && "$(cat "$directory/.managed")" == "$MARKER_TEXT" ]] || continue
    printf '%s\n' "$retained" >> "$INSTALL_ROOT/config/managed-images.list.next"
  done
  mv -f -- "$INSTALL_ROOT/config/managed-images.list.next" "$INSTALL_ROOT/config/managed-images.list"
}

cleanup_stale_staging() {
  python3 - "$INSTALL_ROOT" <<'PY'
import pathlib, re, shutil, sys
root = pathlib.Path(sys.argv[1])
for p in root.iterdir():
    if p.is_symlink() or not p.is_dir() or not re.fullmatch(r'\.staging\.[A-Za-z0-9]{8}', p.name): continue
    marker = p / '.managed'
    owned = not marker.is_symlink() and marker.is_file() and marker.read_text().strip() == 'lumina-gallery-managed-v1'
    if owned or not any(p.iterdir()): shutil.rmtree(p)
# Remove only incomplete snapshots from a killed manager. Completed snapshots are retained.
for p in (root / 'upgrade-backups').iterdir():
    if p.is_symlink() or not p.is_dir() or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}', p.name): continue
    marker = p / '.managed'
    if not marker.is_symlink() and marker.is_file() and marker.read_text().strip() == 'lumina-gallery-managed-v1' and not (p / '.complete').exists(): shutil.rmtree(p)
PY
}

install_manager() {
  install -m 0755 "$(current_release)/scripts/lumina.sh" "$INSTALL_ROOT/lumina.sh.next"
  mv -f -- "$INSTALL_ROOT/lumina.sh.next" "$INSTALL_ROOT/lumina.sh"
  if [[ -e /usr/local/bin/lumina || -L /usr/local/bin/lumina ]]; then
    [[ -L /usr/local/bin/lumina && "$(readlink /usr/local/bin/lumina)" == "$INSTALL_ROOT/lumina.sh" ]] || die '/usr/local/bin/lumina 已被其他文件占用，拒绝覆盖。'
  fi
  ln -sfn "$INSTALL_ROOT/lumina.sh" /usr/local/bin/lumina
}

do_install() {
  prepare_root
  if [[ -f "$INSTALL_ROOT/config/deploy.env" && -L "$INSTALL_ROOT/current" ]]; then
    die '已存在安装；请运行 lumina upgrade，或 lumina start 恢复已卸载的服务。'
  fi
  if [[ -e /usr/local/bin/lumina || -L /usr/local/bin/lumina ]]; then
    [[ -L /usr/local/bin/lumina && "$(readlink /usr/local/bin/lumina)" == "$INSTALL_ROOT/lumina.sh" ]] || die '/usr/local/bin/lumina 已被其他文件占用，拒绝覆盖。'
  fi
  if [[ -z "$DOMAIN" ]]; then read -r -p '图库域名（DNS 已指向本 VPS）：' DOMAIN; fi
  if [[ -z "$EMAIL" ]]; then read -r -p 'HTTPS 证书联系邮箱：' EMAIL; fi
  DOMAIN="${DOMAIN,,}"
  domain_valid "$DOMAIN" || die '请使用有效的域名（不能是 IP、URL 或含路径）。'
  email_valid "$EMAIL" || die '证书邮箱格式无效。'
  check_ports
  fetch_release
  local subnet proxy_ip
  read -r subnet proxy_ip < <(choose_proxy_network)
  [[ -n "$subnet" && -n "$proxy_ip" ]] || die '未找到可用的专用 Docker 网络。'
  write_env "$INSTALL_ROOT/config/deploy.env" "lumina-gallery:$VERSION" "$subnet" "$proxy_ip"
  point_current "$INSTALL_ROOT/releases/$VERSION"
  INSTALL_ACTIVE=1
  compose config --quiet
  compose up -d --no-build
  wait_healthy || die '服务未通过健康检查；安装已停止，数据仍保留。'
  INSTALL_ACTIVE=0
  printf 'installed\n' > "$INSTALL_ROOT/.state"
  install_manager
  cleanup_owned_history
  verify_https || true
  say "安装完成：https://$DOMAIN"
  say '请运行 lumina setup-admin 创建管理员（密码在交互中隐藏输入）。'
}

do_upgrade() {
  managed
  [[ "$(cat "$INSTALL_ROOT/.state" 2>/dev/null)" == installed ]] || die '服务已卸载或安装未完成，请先运行 lumina start。'
  OLD_RELEASE="$(current_release)"
  OLD_IMAGE="$(env_value "$INSTALL_ROOT/config/deploy.env" LUMINA_IMAGE)"
  [[ "$OLD_IMAGE" == "lumina-gallery:${OLD_RELEASE##*/}" ]] || die '当前镜像与版本目录不匹配。'
  DOMAIN="$(env_value "$INSTALL_ROOT/config/deploy.env" LUMINA_DOMAIN)"
  EMAIL="$(env_value "$INSTALL_ROOT/config/deploy.env" ACME_EMAIL)"
  local subnet proxy_ip
  subnet="$(env_value "$INSTALL_ROOT/config/deploy.env" LUMINA_PROXY_SUBNET)"
  proxy_ip="$(env_value "$INSTALL_ROOT/config/deploy.env" LUMINA_PROXY_IP)"
  release_metadata
  if [[ "$VERSION" == "${OLD_RELEASE##*/}" ]]; then say "已是版本 $VERSION。"; return; fi
  newer_version "${OLD_RELEASE##*/}" "$VERSION" || die 'upgrade 仅允许升级到较新的版本；拒绝用旧程序打开新数据库。'
  fetch_release
  # Validate candidate configuration before interrupting the existing service.
  write_env "$TMP_DIR/candidate.env" "lumina-gallery:$VERSION" "$subnet" "$proxy_ip"
  compose_at "$INSTALL_ROOT/releases/$VERSION" "$TMP_DIR/candidate.env" config --quiet
  say '停止图库写入并创建升级前数据库快照……'
  OLD_STOPPED=1
  compose stop -t 60 caddy lumina
  # No writes may resume until either the migration is healthy or rollback finishes.
  checkpoint_backup
  UPGRADE_ACTIVE=1
  cp -- "$TMP_DIR/candidate.env" "$INSTALL_ROOT/config/deploy.env.next"
  mv -f -- "$INSTALL_ROOT/config/deploy.env.next" "$INSTALL_ROOT/config/deploy.env"
  point_current "$INSTALL_ROOT/releases/$VERSION"
  compose up -d --no-build --no-deps lumina
  wait_healthy no || die '升级后健康检查失败。'
  compose up -d --no-build caddy
  wait_healthy || die '升级后代理未能启动。'
  UPGRADE_ACTIVE=0
  OLD_STOPPED=0
  install_manager
  cleanup_owned_history
  verify_https || true
  say "升级完成：$VERSION；数据、账户和网盘/邮件密钥保留。"
}

do_start() {
  managed
  DOMAIN="$(env_value "$INSTALL_ROOT/config/deploy.env" LUMINA_DOMAIN)"
  compose up -d --no-build
  wait_healthy || die '服务未通过健康检查。'
  printf 'installed\n' > "$INSTALL_ROOT/.state"
  install_manager
  verify_https || true
  say "服务已启动：https://$DOMAIN"
}

do_uninstall() {
  managed
  local release confirmation
  release="$(current_release)"
  if (( PURGE )); then
    [[ -t 0 ]] || die '删除数据必须在本机交互终端确认。'
    say '此操作会永久删除所有图库、账户、网盘/邮件密钥、自动备份和 HTTPS 证书。'
    read -r -p '如需永久删除，请输入 DELETE LUMINA DATA：' confirmation
    [[ "$confirmation" == 'DELETE LUMINA DATA' ]] || die '确认文字不匹配，未卸载或删除。'
  fi
  compose down --remove-orphans
  printf 'uninstalled\n' > "$INSTALL_ROOT/.state"
  if (( PURGE )); then
    safe_root; managed
    # Revalidate the fixed root immediately before recursive deletion.
    [[ "$(realpath -e "$INSTALL_ROOT")" == /opt/lumina-gallery && ! -L "$INSTALL_ROOT" ]] || die '删除路径验证失败。'
    if [[ -L /usr/local/bin/lumina && "$(readlink /usr/local/bin/lumina)" == "$INSTALL_ROOT/lumina.sh" ]]; then rm -- /usr/local/bin/lumina; fi
    rm -rf --one-file-system -- "$INSTALL_ROOT"
    say '已卸载，并删除本软件全部数据。Docker 和其他服务保留。'
  else
    say '已卸载服务，图库和设置保留在 /opt/lumina-gallery；运行 lumina start 可恢复。Docker 和其他服务保留。'
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if (( UPGRADE_ACTIVE )); then
    if ! rollback; then
      ROLLBACK_FAILED=1
      say "自动回滚未完成，请保留 $ROLLBACK_DIR 并检查 Docker；请先确认新服务已停止，再按升级快照恢复。" >&2
      status=1
    fi
  elif (( OLD_STOPPED )); then
    say '升级前快照未完成，恢复原服务……' >&2
    compose_at "$OLD_RELEASE" "$INSTALL_ROOT/config/deploy.env" up -d --no-build
  elif (( INSTALL_ACTIVE )); then
    compose down --remove-orphans >/dev/null 2>&1
  fi
  if [[ -n "$ROLLBACK_DIR" && $SNAPSHOT_READY -eq 0 && "$ROLLBACK_DIR" == "$INSTALL_ROOT/upgrade-backups/"* && -d "$ROLLBACK_DIR" && ! -L "$ROLLBACK_DIR" ]]; then
    if [[ -f "$ROLLBACK_DIR/.managed" && "$(cat "$ROLLBACK_DIR/.managed")" == "$MARKER_TEXT" ]]; then rm -rf -- "$ROLLBACK_DIR"; fi
  fi
  # Bound failed-upgrade history too. Never prune while a failed rollback is unresolved.
  if [[ $ROLLBACK_FAILED -eq 0 && $UPGRADE_ACTIVE -eq 0 && -f "$INSTALL_ROOT/.state" && "$(cat "$INSTALL_ROOT/.state")" == installed ]]; then
    if validate_env "$(current_release)" "$INSTALL_ROOT/config/deploy.env" >/dev/null 2>&1; then cleanup_owned_history >/dev/null 2>&1; fi
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" && "$TMP_DIR" == "$INSTALL_ROOT/.staging."* && ! -L "$TMP_DIR" ]]; then rm -rf -- "$TMP_DIR"; fi
  exit "$status"
}

menu() {
  local choice
  while true; do
    say '1 安装  2 升级  3 查看状态  4 查看日志  5 创建管理员  6 卸载（保留数据）  7 恢复启动  0 退出'
    read -r -p '请选择：' choice || return
    case "$choice" in
      1) bash "$0" install ;; 2) bash "$0" upgrade ;; 3) bash "$0" status ;; 4) bash "$0" logs ;;
      5) bash "$0" setup-admin ;; 6) bash "$0" uninstall ;; 7) bash "$0" start ;; 0) return ;; *) say '请输入菜单中的数字。' ;;
    esac
  done
}

main() {
  local command="${1:-menu}"; (( $# == 0 )) || shift
  if [[ "$command" == --help || "$command" == help ]]; then usage; return; fi
  case "$command" in install|upgrade|uninstall|start|status|logs|setup-admin|menu) ;; *) usage; die '未知命令。' ;; esac
  while (( $# )); do
    case "$1" in
      --domain) [[ "$command" == install && $# -ge 2 ]] || die '--domain 仅适用于 install。'; DOMAIN="$2"; shift 2 ;;
      --email) [[ "$command" == install && $# -ge 2 ]] || die '--email 仅适用于 install。'; EMAIL="$2"; shift 2 ;;
      --version) [[ ( "$command" == install || "$command" == upgrade ) && $# -ge 2 ]] || die '--version 仅适用于 install/upgrade。'; VERSION="${2#v}"; version_valid "$VERSION" || die '版本格式无效。'; shift 2 ;;
      --purge-data) [[ "$command" == uninstall ]] || die '--purge-data 仅适用于 uninstall。'; PURGE=1; shift ;;
      *) die "未知参数：$1" ;;
    esac
  done
  [[ "$(uname -s)" == Linux ]] || die '此安装器仅用于 Linux VPS。'
  [[ $EUID -eq 0 ]] || die '请使用 sudo bash lumina.sh 或 sudo lumina。'
  if [[ "$command" == menu ]]; then menu; return; fi
  ensure_dependencies
  safe_root
  if [[ "$command" == install ]]; then prepare_root; else managed; fi
  exec 9>"$INSTALL_ROOT/.manager.lock"
  flock -n 9 || die '另一个安装/升级/卸载任务正在进行。'
  cleanup_stale_staging
  ensure_docker
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  TMP_DIR="$(mktemp -d "$INSTALL_ROOT/.staging.XXXXXXXX")"
  printf '%s\n' "$MARKER_TEXT" > "$TMP_DIR/.managed"
  case "$command" in
    install) do_install ;; upgrade) do_upgrade ;; uninstall) do_uninstall ;; start) do_start ;;
    status) compose ps; say "图库数据：$INSTALL_ROOT/data" ;;
    logs) compose logs --tail 200 ;;
    setup-admin) compose exec lumina node scripts/setup-admin.mjs ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
