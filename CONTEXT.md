# EgressKit

EgressKit 将传输节点聚合成统一的出口访问服务，并为调用方管理出口身份与会话绑定。

## Language

**传输节点（transport node）**：一组连接配置及其 generation 所代表的上游代理节点。多个传输节点可能共享同一个出口身份。

**出口身份（egress identity）**：经过验证的公网出口 IP。轮换与会话绑定以出口身份为单位。

**正向代理请求（forward proxy request）**：调用方通过代理协议提交的 HTTP 请求或 CONNECT 隧道。CONNECT 隧道中的 HTTPS 业务请求沿用该隧道的出口身份。

**反向代理请求（relay request）**（控制台接入方式标为“URL 转发”）：调用方将目标地址与路由模式包含在网关 URL 中提交的普通 HTTP 请求。每个请求独立选路，并沿用与正向代理相同的出口身份和会话绑定规则。
_Avoid_: 非 HTTP 请求（这种接入仍然使用 HTTP，只是不要求客户端使用 HTTP Proxy / CONNECT 协议）
