# EgressKit

<p align="center">
  <img src="apps/web/public/brand/egresskit-logo.svg" alt="EgressKit" height="48">
</p>

<p align="center">
  将 Clash / VLESS 节点聚合为一个可编程的 HTTP 代理入口。
</p>

EgressKit 是一个开源、自托管的代理网关。客户端只连接一个 HTTP 代理地址，通过用户名选择轮换出口、会话粘连、严格粘连或指定出口。订阅更新、Mihomo、节点探活、出口 IP 识别、调度和失败回退都由 EgressKit 处理。

> [!IMPORTANT]
> 当前镜像支持 Linux amd64 和 arm64。Windows 不在 v1 支持范围内。

> [!WARNING]
> EgressKit 是完整 HTTP 代理，默认应启用代理认证。状态数据库会以明文保存订阅 URL、节点凭据和 Proxy Token，请保护状态目录及其备份。

## 快速开始

启动 `0.1.0` 镜像：

```bash
docker run --detach \
  --name egresskit \
  --restart unless-stopped \
  --volume egresskit-state:/var/lib/egresskit \
  --publish 127.0.0.1:8787:8787 \
  --env EGRESSKIT_ADMIN_TOKEN='change-this-admin-token' \
  ghcr.io/heyjunpenn/egresskit:0.1.0
```

打开 <http://127.0.0.1:8787>，输入 Admin Token，然后在“订阅”页面添加 Clash / Mihomo HTTPS 订阅。Proxy Token 首次与 Admin Token 相同，可以在“设置”页面随机重置。

确认服务状态：

```bash
curl --fail http://127.0.0.1:8787/live
curl --fail http://127.0.0.1:8787/ready
```

`/live` 表示进程存活；`/ready` 表示 Mihomo 和至少一个已验证出口可以接流量。订阅刚导入时，节点需要完成探活和出口 IP 识别，`/ready` 暂时未就绪是正常的。

## 发起代理请求

代理使用 HTTP Basic Auth。用户名表示路由模式，密码填写 Proxy Token。

使用最长时间未使用的出口 IP：

```bash
curl \
  --proxy 'http://127.0.0.1:8787' \
  --proxy-user 'rotate:YOUR_PROXY_TOKEN' \
  'https://www.cloudflare.com/cdn-cgi/trace'
```

使用出口 IP 粘连会话：

```bash
curl \
  --proxy 'http://127.0.0.1:8787' \
  --proxy-user 'sticky.crawler-job-42:YOUR_PROXY_TOKEN' \
  'https://example.com'
```

上例的用户名是 `sticky.crawler-job-42`，密码是 `YOUR_PROXY_TOKEN`。也可以直接写成 URL：

```bash
curl \
  --proxy 'http://sticky.crawler-job-42:YOUR_PROXY_TOKEN@127.0.0.1:8787' \
  'https://example.com'
```

### 路由模式

| 代理用户名 | 用途 | 出口不可用时 |
| --- | --- | --- |
| `rotate` | 每个新代理请求或新 CONNECT 隧道选择最长未使用的出口 IP | 建连确认前尝试其他可用出口 |
| `sticky.<session-key>` | 相同 session key 尽量保持同一出口 IP | 可重新绑定到其他出口 IP |
| `strict.<session-key>` | 相同 session key 严格保持同一出口 IP | 同 IP 的传输节点均不可用时失败 |
| `node.<alias-or-id>` | 使用指定节点所代表的出口 IP | 仅在同 IP 的传输节点之间回退 |

`rotate` 的轮换单位是新 HTTP 代理请求或新 HTTPS CONNECT 隧道。一个已经建立的 HTTPS 隧道内部可以承载多个请求，EgressKit 不会在隧道中途切换出口。

指定包含特殊字符的节点 ID 时，需要对用户名中的 ID 做 URL 编码。例如逻辑 ID `local:primary` 使用：

```text
node.local%3Aprimary
```

### Playwright

```typescript
import { chromium } from "playwright";

const browser = await chromium.launch({
  proxy: {
    server: "http://127.0.0.1:8787",
    username: "sticky.playwright-session",
    password: process.env.EGRESSKIT_PROXY_TOKEN,
  },
});

const page = await browser.newPage();
await page.goto("https://example.com");
```

浏览器通常会复用连接。需要每个任务重新选出口时，应创建新的浏览器上下文或连接，并使用新的 session key。页面请求次数不等于代理轮换次数。

## 管理订阅与节点

Web 控制台可以：

- 添加、编辑、删除和手动刷新远程 HTTPS 订阅。
- 查看订阅 revision 和处理状态。
- 查看节点健康、延迟、出口 IP 及 `country-city` 位置信息。
- 手动验证节点的出口 IP。
- 启用或禁用节点，并配置可读 alias。
- 查看请求日志并重放控制台中的请求配置。

远程订阅默认每 10 分钟刷新一次。更新状态分为保存、下载、解析、验证、应用和健康检查。下载或校验失败不会清空当前节点池；订阅节点数量异常减少时，需要管理员确认后才能强制应用。

## 工作原理

EgressKit 不实现 VLESS 协议。它管理独立的官方 Mihomo 进程，在 VLESS 节点之上提供统一的 HTTP 代理入口。

```mermaid
flowchart LR
    client["curl / Playwright / HTTP 客户端"] -->|"HTTP proxy / CONNECT"| gateway["EgressKit :8787"]
    gateway --> auth["认证与模式解析"]
    auth --> sessions["会话与出口 IP 绑定"]
    sessions --> scheduler["按出口 IP 调度"]
    scheduler --> fallback["建连前失败回退"]

    subscriptions["Clash / Mihomo 订阅"] --> registry["节点注册表"]
    health["探活与出口 IP 发现"] --> registry
    registry --> scheduler
    sqlite[("SQLite")]
    subscriptions <--> sqlite
    sessions <--> sqlite
    health <--> sqlite

    fallback --> listenerA["Mihomo listener A"]
    fallback --> listenerB["Mihomo listener B"]
    fallback --> listenerC["Mihomo listener C"]
    listenerA --> vlessA["VLESS 节点 A"]
    listenerB --> vlessB["VLESS 节点 B"]
    listenerC --> vlessC["VLESS 节点 C"]
```

### 从订阅到可用出口

1. EgressKit 下载并解析 Clash / Mihomo YAML，只接收通过严格校验的 VLESS 节点。
2. 每个节点获得稳定 logical ID；连接参数改变时生成新的 configuration generation。
3. EgressKit 生成专用 Mihomo 配置，为每个活跃传输节点分配独立的 loopback HTTP listener。
4. 健康检查通过对应 listener 发出，从而覆盖 VLESS、DNS、TLS / Reality 和目标访问链路。
5. 通过健康检查的节点继续查询公网出口身份。所有待验证节点都会排队，出口探测最多同时执行 5 个。
6. 只有同时健康且取得出口 IP 的节点才会进入可调度集合。出口 IP、位置、提供方和验证时间按 logical ID 与 generation 保存到 SQLite。

节点配置变化后会生成新的 generation，旧出口身份不会被复用。daemon 重启时恢复匹配的身份记录，但节点仍需通过本轮健康检查才能接流量。

### 为什么按出口 IP 调度

多个订阅节点可能最终共用一个公网 IP。如果按节点轮换，这些重复节点会占据多个轮换位置，调用方看到的 IP 仍然不变。

EgressKit 区分两个概念：

- 传输节点：一个 Clash / VLESS 节点 generation，以及对应的 Mihomo listener。
- 出口身份：经过验证的公网 IP，也是调用方看到的路由身份。

所有路由策略都以出口 IP 为单位。`rotate` 先选择最长未使用的 IP 组，再从组内选择健康传输节点；sticky 与 strict 会话保存出口 IP；指定节点模式先把 ID 或 alias 解析成出口 IP，再允许同 IP 的其他传输节点承接连接。

### HTTPS 为什么需要 CONNECT 隧道

客户端访问 HTTPS 地址时，代理不能直接读取或重建加密请求。客户端先向 EgressKit 发送 `CONNECT host:443`，EgressKit 选择出口并建立到目标的 TCP 通道，成功后返回 `200 Connection Established`。之后 TLS 握手和加密数据在客户端与目标站之间传输，EgressKit 只转发字节，不解密业务内容。

透明回退只能发生在返回 CONNECT 200 之前。隧道建立后如果节点断开，EgressKit 会关闭连接，由客户端决定是否重连。EgressKit 不会切换已经建立的隧道，也不会自动重放请求。

### 节点生命周期

```mermaid
stateDiagram-v2
    [*] --> warming: 导入或 generation 变化
    warming --> healthy: 探活成功且已验证出口 IP
    warming --> cooldown: 连续失败
    healthy --> degraded: 连接质量下降
    degraded --> healthy: 后续成功
    degraded --> cooldown: 达到失败阈值
    cooldown --> warming: 冷却结束并重新探活
    healthy --> draining: 订阅移除或配置替换
    draining --> removed: 活跃连接归零
    warming --> disabled: 管理员禁用
    healthy --> disabled: 管理员禁用
    disabled --> warming: 管理员启用
```

手动禁用与运行健康状态相互独立。订阅移除或配置变更不会立即切断既有连接：旧 generation 进入 `draining`，停止接收新连接，等活动连接归零后再移除 listener。

## 配置与持久化

`EGRESSKIT_ADMIN_TOKEN` 是唯一环境变量。其他参数首次启动时写入 SQLite，通过控制台管理。Proxy Token 首次与 Admin Token 相同，生产环境应改成独立随机值。

主要默认值：

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| 代理监听 | `0.0.0.0:8787` | HTTP 代理、控制 API 和控制台入口 |
| 健康检查周期 | 30 秒 | 带最多 5 秒抖动 |
| 健康检查并发 | 4 | 与出口 IP 探测并发限制相互独立 |
| 出口 IP 探测并发 | 5 | 队列总量不设上限 |
| 订阅刷新周期 | 600 秒 | 远程订阅自动更新 |
| 建连前尝试次数 | 3 | 返回响应或发送业务请求前的候选尝试 |
| 单次建连超时 | 10 秒 | 每个候选 listener 的连接上限 |
| Session 绝对 TTL | 1800 秒 | 到期后允许创建新绑定 |
| Session 空闲 TTL | 300 秒 | 长时间无使用后释放绑定 |
| 单 Session 并发 | 50 | 最大活动连接数 |
| 最大活动 Session | 10000 | 防止无界增长 |

默认状态目录：

| 环境 | 路径 |
| --- | --- |
| Linux / Docker 且目录存在 | `/var/lib/egresskit` |
| 其他环境 | `~/.local/state/egresskit` |

SQLite 是 daemon 的控制面数据库，保存订阅、规范化节点、generation、端口分配、出口身份、会话绑定、设置、revision 和 operation。它不保存每个代理请求或数据包。`egressd` 是唯一写入者，CLI 和 Web 控制台都通过管理 API 修改状态。

## 部署说明

镜像发布在 `ghcr.io/heyjunpenn/egresskit`，内置固定且经过 SHA-256 校验的官方 Mihomo。请使用明确版本，不要使用浮动的 `latest`。

快速开始中的端口映射只监听宿主机 loopback。需要从局域网或公网访问时，请保留代理认证，并配置防火墙、TLS 终止和管理面访问控制。

更多部署与运行时细节：

- [部署和发布支持](docs/deployment.md)
- [Mihomo 安装与版本](docs/mihomo.md)
- [出口 IP 路由决策](docs/adr/0002-egress-ip-routing-identity.md)
- [数据库设置决策](docs/adr/0001-database-backed-runtime-settings.md)

## 监控与故障排查

| 地址 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /live` | 无 | Node.js 进程存活状态 |
| `GET /ready` | 无 | Mihomo 和可调度出口就绪状态 |
| `GET /metrics` | Bearer Admin Token | Prometheus 指标 |
| `GET /console/snapshot` | Bearer Admin Token | Web 控制台聚合快照 |

常见问题：

- **`407 Proxy Authentication Required`**：Proxy Token 不正确，或者仍在使用旧 Token。登录控制台核对或重置。
- **`/ready` 尚未就绪**：节点仍在 warming、Mihomo 配置未成功应用，或没有节点同时通过探活和出口 IP 验证。
- **Rotate 没有换 IP**：客户端可能复用了 CONNECT 隧道，也可能有多个节点共用同一公网 IP。重新建立连接，并在代理列表查看出口 IP。
- **IP 查询返回 429**：查询站点触发了限流，不代表 EgressKit 没有轮换。以控制台中后端验证并保存的出口 IP 为准。
- **订阅更新后节点减少**：EgressKit 会保留当前 revision，避免错误页、空响应或截断内容清空节点池。确认供应方确实减少节点后再强制应用。
- **HTTPS 建连后断开**：CONNECT 隧道不会中途迁移。客户端需要重新连接，并根据请求是否幂等决定要不要重试。

查看后端聚合状态：

```bash
curl \
  --header 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  'http://127.0.0.1:8787/console/snapshot'
```

## 安全边界

- 不要把 Admin Token、Proxy Token、订阅 URL 或状态数据库提交到 Git。
- Admin Token 控制管理面；Proxy Token 控制代理数据面。首次默认相同，部署后应立即分开。
- EgressKit 不解密 HTTPS 内容，也不会在 CONNECT 建立后自动重放请求。
- 远程管理 API 始终脱敏订阅 URL；本机 CLI 可读取完整 URL，输出到日志前请使用 `--redact`。
- 状态目录和备份属于凭据边界，应限制本机访问并使用受控的备份策略。
- 关闭代理认证只适用于完全受控的 loopback 环境；非 loopback 监听会拒绝无认证启动。

## License

EgressKit 使用 Apache-2.0 许可证。Mihomo 作为独立的 GPL-3.0 进程运行；相关许可证、归属和对应源码说明随发布产物提供。
