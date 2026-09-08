# Deployment and release support

## v1 support matrix

| Distribution | Architecture | v1 status |
| --- | --- | --- |
| Linux CLI and daemon | Linux x64 | Supported and built in the release matrix |
| Linux CLI and daemon | Linux arm64 | Supported and built in the release matrix |
| macOS CLI and daemon | macOS x64 | Supported and built in the release matrix |
| macOS CLI and daemon | macOS arm64 | Supported and built in the release matrix |
| Linux Docker | linux/amd64 | Supported multi-architecture image |
| Linux Docker | linux/arm64 | Supported multi-architecture image |

Windows 不在 v1 的正式支持范围。发布流水线会在四种受支持的宿主组合上安装依赖、执行
`pnpm verify`、构建 `egresskit` CLI 与 `egressd` daemon，并分别保存构建归档。Docker
manifest 同时包含 `linux/amd64` 与 `linux/arm64`。

## State-directory security

状态目录是敏感数据边界。SQLite 数据库按产品决策使用明文存储，不启用 SQLCipher、字段加密，
也不由 EgressKit 主动修改系统默认文件权限。数据库可能含有完整订阅 URL、VLESS 节点凭据、
会话绑定和运行时状态；部署者必须限制状态目录的本机访问。

状态目录的备份同样可能包含凭据和其他敏感数据。部署者负责备份的访问控制、加密、保留周期和
安全删除。不要把数据库、备份、管理 token 或代理 token 加入镜像或公开构建产物。

## Docker runtime

镜像内置并校验固定的官方 Mihomo `v1.19.30`，不使用 `latest` 或 Alpha 资产。默认状态目录是
`/var/lib/egresskit`，应挂载持久卷并仅授予容器运行用户访问权限。EgressKit 与 Mihomo 的许可证、
归属和 Mihomo 对应源码获取方式随镜像一起放在 `/usr/share/licenses/egresskit`。

示例：

```sh
docker run --rm \
  -v egresskit-state:/var/lib/egresskit \
  -e EGRESSKIT_ADMIN_TOKEN='replace-me' \
  -e EGRESSKIT_PROXY_TOKENS='replace-me' \
  ghcr.io/heyjunpenn/egresskit:VERSION
```
