import { Clipboard, CloudArrowDown } from "@phosphor-icons/react";
import { useConsole } from "./App";
import { AnimatedBadge } from "./components/motion/animated-badge";
import { Button } from "./components/motion/button/base";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { gatewayAddress } from "./lib/gateway-address";

export function DocsPage() {
  const { snapshot } = useConsole();
  const proxy = `http://${gatewayAddress(snapshot.gateway.host, snapshot.gateway.port)}`;
  const sections = [
    ["1", "配置 Proxy Token", "在服务端设置独立的 Proxy Token，不要复用 Admin Token。"],
    [
      "2",
      "选择路由模式",
      "使用 rotate、sticky.<session>、strict.<session> 或 node.<selector> 作为代理用户名。",
    ],
    ["3", "发起请求", "通过标准 HTTP_PROXY / HTTPS_PROXY 或 curl --proxy 接入。"],
  ];

  return (
    <>
      <Card className="mb-4">
        <CardContent className="flex items-center gap-4">
          <CloudArrowDown size={24} />
          <div>
            <p className="text-sm text-muted-foreground">当前代理入口</p>
            <code className="text-lg font-semibold">{proxy}</code>
          </div>
          <Button
            variant="secondary"
            size="icon"
            className="ml-auto"
            aria-label="复制代理入口"
            onClick={() => void navigator.clipboard?.writeText(proxy)}
          >
            <Clipboard />
          </Button>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-[.65fr_1.35fr]">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>快速开始</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {sections.map(([number, title, copy]) => (
              <div className="flex gap-4" key={number}>
                <AnimatedBadge status="info" showIcon={false}>
                  {number}
                </AnimatedBadge>
                <div>
                  <strong>{title}</strong>
                  <p className="mt-1 max-w-[70ch] text-sm leading-6 text-muted-foreground">
                    {copy}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>路由模式</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {[
              ["rotate", "每个新 CONNECT 隧道或普通 HTTP 代理请求选择节点"],
              ["sticky.<session>", "节点失效时可重新绑定，优先保证可用性"],
              ["strict.<session>", "绑定失效后拒绝自动迁移，避免出口漂移"],
              ["node.<selector>", "固定使用指定节点或别名"],
            ].map(([mode, copy]) => (
              <div className="flex flex-wrap items-baseline justify-between gap-2 py-3" key={mode}>
                <code className="font-semibold">{mode}</code>
                <p className="text-sm text-muted-foreground">{copy}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Docker 启动</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-lg bg-foreground p-4 text-xs leading-6 text-background">
              <code>{`docker run --rm \
  -v egresskit-state:/var/lib/egresskit \
  -p 127.0.0.1:8787:8787 \
  -e EGRESSKIT_ADMIN_TOKEN='…' \
  -e EGRESSKIT_PROXY_TOKEN='…' \
  ghcr.io/heyjunpenn/egresskit:VERSION`}</code>
            </pre>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>存活与就绪</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
            <p>
              <code>/live</code> 表示 Node 进程存活；<code>/ready</code> 表示 Mihomo
              已就绪且至少存在一个可调度节点。
            </p>
            <AnimatedBadge status="success">两个探针无需 Admin Token</AnimatedBadge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>鉴权与指标</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
            <p>
              控制台与管理 API 使用 Admin Token；代理流量使用 Proxy Token。除 /live 与 /ready
              外，管理接口均需 Bearer 鉴权。
            </p>
            <p>
              使用 <code>Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code> 读取
              <code> /metrics</code>。
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
