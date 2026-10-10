# 快速操作：查询出口 IP

打开控制台的“快速操作”页面，使用同一个目标分别验证正向代理与 URL 转发。

## 选择接入方式

| 页面名称 | 请求方式 | 认证 | 适用场景 |
| --- | --- | --- | --- |
| 正向代理 | HTTP Proxy / CONNECT | 代理用户名 + Proxy Token | 标准 HTTP 客户端、Playwright；直连代理端口或四层 TCP 转发 |
| URL 转发（Relay） | 普通 HTTP 请求，目标包含在 `/relay/...` 路径中 | `X-EgressKit-Token` | Web API、HTTP SDK；可经 CDN / HTTP 反代接入 |

“URL 转发”是控制台对反向代理请求的命名。这种方式仍使用 HTTP，客户端无需配置代理协议。
“接入方式”与“选路模式”分别选择：两种接入均支持 Rotate、Soft sticky、Strict sticky 和指定节点。
选路与会话语义见 [README 的路由模式](../README.md#路由模式)。

## 在页面中查询

1. 选择“正向代理”或“URL 转发”。
2. 选择选路模式；选择“指定节点”时填写节点 ID 或 alias。
3. 点击“检查出口 IP”，目标 URL 会设置为 `https://api.ipify.org`。这一步只填写目标。
4. 点击“发起请求”，查看 HTTP 状态、耗时与响应正文。成功时正文包含所选出口的公网 IP。
5. 切换接入方式并再次请求，可分别验证两种入口。

右侧 curl 示例会随接入方式、选路模式、目标和 Proxy Token 更新，可点击复制按钮在客户端运行。
页面保留最近 20 条请求记录，显示接入方式、选路模式、状态和时间；点击记录可恢复当时的
接入方式、选路模式、节点、目标与响应。记录仅保留在当前页面中，刷新或离开页面后清空。

页面测试由 daemon 通过本机正向代理或 Relay 入口发起 GET 请求。若要验证公开域名、CDN、
外部端口与 TLS 配置，请在客户端执行生成的 curl 命令。

## 两种 IP 查询命令

以下域名和 `YOUR_PROXY_TOKEN` 需要替换为实际值。Proxy Token 在控制台“设置”页管理。

正向代理通过代理用户名 `rotate` 选路，Proxy Token 作为密码：

```sh
curl --silent --show-error --max-time 30 \
  --proxy 'http://proxy.example.com:8787' \
  --proxy-user 'rotate:YOUR_PROXY_TOKEN' \
  'https://api.ipify.org'
```

URL 转发通过路径中的 `rotate` 选路，Proxy Token 放在请求头：

```sh
curl --silent --show-error --max-time 30 \
  'https://egress.example.com/relay/rotate/https/api.ipify.org/' \
  -H 'X-EgressKit-Token: YOUR_PROXY_TOKEN'
```

URL 转发路径为 `/relay/<路由>/<http|https>/<目标主机及端口>/<目标路径>?查询参数`。
例如 JSON 响应可使用 `/relay/rotate/https/api.ipify.org/?format=json`。
切换 Sticky 时，将 `rotate` 换成 `sticky.<session-key>` 或 `strict.<session-key>`；
指定节点使用 `node.<alias-or-id>`。包含特殊字符时，按 README 说明编码整个路由段。

## 配置页面展示的公开地址

通过 daemon 启动环境变量设置：

```sh
export EGRESSKIT_PUBLIC_PROXY_URL=http://proxy.example.com:8787
export EGRESSKIT_PUBLIC_RELAY_URL=https://egress.example.com
```

只提供协议、主机和可选端口，不添加 `/relay/`、目标路径、认证信息、查询参数或片段。
两个变量分别用于正向代理和 URL 转发的入口展示、复制及 curl 示例；不保存到 SQLite。
修改后重启 daemon；Docker 需要用新环境变量重新创建容器。未设置或留空时自动生成：
正向代理使用监听主机和端口（监听所有网卡时使用控制台主机名），URL 转发使用当前控制台 origin。

公开地址变量不会设置 DNS、CDN 或端口转发。相关部署配置见 [部署指南](deployment.md#cdn--http-反代接入)。

## 解读结果

- 两次 Rotate 返回相同 IP：多个节点可能共享同一出口，或可用出口不足；不保证每次都不同。
- `407`：正向代理认证失败；`401`：URL 转发认证失败。检查 Proxy Token 与认证位置。
- `502` 或请求错误：检查节点就绪状态、目标可达性与网络连接。
- IP 查询返回 `429`：目标站点限流，可稍后重试或换用其他 IP 查询服务。
