# Docker deployment and release support

## v1 support matrix

| Distribution | Architecture | v1 status |
| --- | --- | --- |
| Linux Docker | linux/amd64 | Supported multi-architecture image |
| Linux Docker | linux/arm64 | Supported multi-architecture image |

EgressKit 仅通过 Docker Hub 分发，不提供宿主机归档或 npm registry 包。发布流水线先执行完整
`pnpm verify`，再分别验证 `linux/amd64` 与 `linux/arm64` 镜像，最后从无前缀的 `x.y.z` tag
发布 `heyjunpenn/egresskit:<version>` 和 `heyjunpenn/egresskit:latest`。多架构镜像附带构建
provenance 与 SBOM。

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
  heyjunpenn/egresskit:latest
```

镜像内的 daemon 监听 `0.0.0.0:8787` 以穿过容器网络；上述端口映射只把服务暴露到宿主机
loopback。若要对其他网络开放端口，必须保留代理认证，并由部署者额外配置防火墙和访问控制。

首次启动时，其余运行参数会以默认值写入 SQLite；Proxy Token 默认与 Admin Token 相同。登录管理
控制台后可在“设置”页修改 Proxy Token、监听参数、Mihomo、探活、订阅刷新与会话限制。除 Proxy
Token 可立即生效外，页面标记的运行参数需要重启 daemon 才会应用。

## 接入方式与入口地址

控制台使用“正向代理”和“URL 转发”命名两种接入方式。正向代理使用 HTTP Proxy / CONNECT，
客户端配置代理地址；URL 转发是普通 HTTP 反向代理请求，客户端把目标包含在 `/relay/...` URL 中。
两种方式的 IP 查询示例和控制台操作见 [快速操作指南](playground.md)。

`EGRESSKIT_PUBLIC_PROXY_URL` 声明正向代理对外地址，`EGRESSKIT_PUBLIC_RELAY_URL` 声明
URL 转发对外地址。它们只影响展示和客户端示例，监听地址仍由 SQLite 中的 `host` / `port` 控制。

## CDN / HTTP 反代接入

将域名的 `/relay/` 路径转发到 EgressKit 的 `8787` 端口；客户端使用普通 HTTPS 请求，
例如 `/relay/sticky.customer-1/https/api.example.com/v1/orders`，并发送
`X-EgressKit-Token: <Proxy Token>`。业务的 `Authorization` 仍发送给目标服务。
此入口复用现有选路、会话限制与 Proxy Token 轮换，不要求 CDN 支持 CONNECT。

Nginx 示例（TLS 证书配置沿用部署环境）：

```nginx
location /relay/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_cache off;
    proxy_next_upstream off;
    proxy_read_timeout 120s;
}
```

`proxy_pass` 不加尾部 `/`，保留完整 relay 路径。CDN 也须对 `/relay/*` 设置缓存绕过、
关闭自动重试，并保留 `X-EgressKit-Token`。EgressKit 响应使用 `Cache-Control: private, no-store`；
客户端和目标之间的请求/响应流式传输，网关的上游空闲超时为 120 秒。CDN 自身的超时、
上传大小、流式能力及路径规范化仍需符合业务需要。目标重定向改写为 relay 路径；这个入口
面向 Web API，不负责重写 HTML、脚本、Cookie 域或整站资源地址，也不支持 WebSocket。

如只需 relay 接入，可以只公开 `/relay/`，管理页面和 API 保持在内网。普通 HTTP 反代不能
让标准 HTTP Proxy / CONNECT 客户端自动兼容 CDN；这类客户端继续使用直连或四层 TCP 转发。

### 配置对外入口地址

通过守护进程的环境变量分别声明两个公开入口：

```sh
export EGRESSKIT_PUBLIC_PROXY_URL=http://proxy.example.com:8787
export EGRESSKIT_PUBLIC_RELAY_URL=https://egress.example.com
```

Docker 启动时添加 `-e EGRESSKIT_PUBLIC_PROXY_URL='http://proxy.example.com:8787'` 和
`-e EGRESSKIT_PUBLIC_RELAY_URL='https://egress.example.com'`。这两个变量在启动时读取，
用于控制台入口展示、复制内容和调用示例，不保存到 SQLite。修改后需重启服务；Docker 需要
使用新环境变量重新创建容器。只填写协议、域名及端口，不填写用户名、密码、`/relay/`、目标路径、查询参数或片段。
未设置或留空时，监听所有网卡的 HTTP 代理使用控制台域名加真实监听端口；反向代理使用当前网页 origin。
声明公开地址不修改服务的监听地址或部署转发规则。


“快速操作”的“发起请求”由 daemon 通过本机入口执行 GET，用于检查节点选路与目标响应。
它不会通过上述公开域名访问 CDN；要确认外部部署可用，应在客户端执行页面生成的 curl 命令。
