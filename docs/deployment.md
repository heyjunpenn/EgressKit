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

Windows 不在 v1 的正式支持范围。发布流水线通过独立任务执行一次完整 `pnpm verify`。
四种受支持的宿主组合分别执行构建、打包、安装和双入口 smoke，并保存构建归档。Docker manifest 同时包含
`linux/amd64` 与 `linux/arm64`。正式镜像与 GitHub Release 都依赖完整质量验证成功。

带版本的 GitHub Release 附件是 v1 CLI 和 daemon 归档的正式下载渠道；项目不从 npm registry
发布。归档内部 package version 必须与无前缀的 `x.y.z` release tag 完全一致。容器镜像从同一 tag 发布到
`ghcr.io/heyjunpenn/egresskit`，并附带构建 provenance 与 SBOM。

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
  -p 127.0.0.1:8787:8787 \
  -e EGRESSKIT_ADMIN_TOKEN='replace-me' \
  ghcr.io/heyjunpenn/egresskit:0.1.0
```

镜像内的 daemon 监听 `0.0.0.0:8787` 以穿过容器网络；上述端口映射只把服务暴露到宿主机
loopback。若要对其他网络开放端口，必须保留代理认证，并由部署者额外配置防火墙和访问控制。

首次启动时，其余运行参数会以默认值写入 SQLite；Proxy Token 默认与 Admin Token 相同。登录管理
控制台后可在“设置”页修改 Proxy Token、监听参数、Mihomo、探活、订阅刷新与会话限制。除 Proxy
Token 可立即生效外，页面标记的运行参数需要重启 daemon 才会应用。
