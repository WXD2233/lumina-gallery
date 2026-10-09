# Linux VPS 一键安装、升级和卸载

项目仓库：<https://github.com/WXD2233/lumina-gallery>。正式发布包包含 Linux x64（amd64）和 ARM64 容器镜像；安装脚本按服务器架构选择镜像，校验 SHA-256 后加载。无需在 VPS 安装 Node.js 或自行编译前端。

## 安装前

- 准备指向 VPS 的域名，A / AAAA 记录都必须正确；仅设置了 IPv4 的服务器不要保留错误的 AAAA 记录。
- 开放入站 TCP 80、443；UDP 443 可选，用于 HTTP/3。服务器已有 Nginx、Caddy、宝塔等占用 80/443 时，脚本会停止，请采用 README 中的已有反向代理部署方式。
- 使用 root 或具有 sudo 权限的账户。推荐 Debian / Ubuntu；其他 Linux 发行版先自行安装 Docker Engine 和 Compose v2。
- 为原图、自动备份和容器镜像预留足够磁盘空间。脚本的空间检查不能预估你未来要导入的全部图片。

## 一键安装

在 VPS 的 SSH 终端执行：

```sh
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/WXD2233/lumina-gallery/main/scripts/lumina.sh -o lumina.sh && sudo bash lumina.sh install
```

按提示填写域名和证书联系邮箱。脚本下载发布包、校验文件、创建独立容器网络、启动图库和 Caddy。Caddy 自动申请和续期证书；后端端口不会直接发布到宿主机。域名解析、80/443 可达和证书签发成功后，通过 `https://你的域名` 访问。证书目录持久保存，日常重启不会丢失。

首次创建管理员：

```sh
sudo lumina setup-admin
```

密码从交互式终端输入，输入时隐藏，不使用命令行参数。没有默认密码；已有账号不会被覆盖。

安装后可用 `sudo lumina` 打开管理菜单。

## 一键升级

```sh
sudo lumina upgrade
```

升级使用最新正式发布版本，保留原图、图库、账户、头像、邮箱及 WebDAV 配置。先下载并校验新版本，然后暂停网页入口、停止旧服务并保存一致的数据库快照，再启动新服务。健康检查失败时停止新版本，恢复原数据库并重新启动上一版。

升级快照保护数据库，原图保留在原数据目录；它不是另一份完整原图备份。完整图库备份仍由软件的每周备份 / WebDAV 功能提供。健康检查验证服务能启动，不能替代逐项业务检查；重大版本升级前建议额外导出完整 ZIP。

自动回退覆盖检查失败和正常中断；突然断电或 `SIGKILL` 可能发生在配置与版本指针切换之间。此时管理器会拒绝不一致的启动，保留数据和升级快照，需要先人工恢复一致的配置、数据库与版本。不要删除快照、强行启动多个实例或覆盖现有图库。

程序仅维护自己生成的版本目录和升级快照，并限制保留数量；不会执行全局 Docker 清理或删除其他项目的镜像和容器。

## 一键卸载

```sh
sudo lumina uninstall
```

默认停止并删除本程序的容器和网络，**保留 `/opt/lumina-gallery` 中的图库和配置**；执行 `sudo lumina start` 可恢复服务。不会卸载 Docker，也不会修改其他网站。需要永久清除图库时，执行 `sudo lumina uninstall --purge-data`，并按提示完成本机确认；删除后无法通过管理器恢复。

## 状态与排错

```sh
sudo lumina status
sudo lumina logs
```

默认安装布局：

| 位置 | 内容 |
| --- | --- |
| `/opt/lumina-gallery/data` | 原图、图库数据库、头像、自动备份、应用日志 |
| `/opt/lumina-gallery/config/deploy.env` | 域名、部署镜像、数据路径与代理地址 |
| `/opt/lumina-gallery/config/caddy-data` | HTTPS 证书和续期资料 |
| `/opt/lumina-gallery/config/caddy-config` | Caddy 持久配置 |
| `/opt/lumina-gallery/releases` | 当前及上一版程序 |
| `/opt/lumina-gallery/upgrade-backups` | 升级前数据库快照 |

安装成功但域名访问失败时，先检查 DNS、防火墙、证书日志及云服务商安全组。脚本不会自动关闭防火墙、停止已有网站或绕过证书验证。服务健康不代表公网证书已签发成功。

## 已有 VPS 数据迁移

首次安装不会读取你 Windows 电脑上的 `data` 目录，也不会自动上传它。迁移已有图库应先停止旧服务，完整复制私有 `data`（包括 `gallery.db`、`uploads` 和 `security-mail.key`），再放到安装数据目录并确保 UID 1000 可写。不要同时运行两个使用同一数据目录的实例。

手动复制整个数据目录会保留账户和连接凭据，必须通过受保护的传输方式进行；软件导出的图库 ZIP 不含账户及 SMTP/WebDAV 凭据。详细恢复说明见 [README](README.md)。

## 发布文件与校验

GitHub Releases 提供 `lumina-gallery-版本-source.tar.gz`、两个 Linux 架构镜像压缩包和 `SHA256SUMS`。校验值可检测文件损坏，下载来源的信任仍依赖 GitHub HTTPS 和仓库权限；不要关闭 TLS 校验或运行未知来源的同名脚本。

部署使用 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)，Docker 安装依据 [Docker 官方文档](https://docs.docker.com/engine/install/ubuntu/)。
