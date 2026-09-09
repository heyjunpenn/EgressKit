# EgressKit Design System

EgressKit 的产品界面服务于自托管代理控制面。设计来自参考图的明亮画布、克制描边、圆形控制、紧凑数据模块与橙红强调，但不复刻金融业务内容。

## Brand idea

图形标志把一个入口、中心调度点和三个出口压缩为一个 64×64 几何符号。黑色圆角底表示稳定控制面，橙红色的中央决策节点与三个出口节点组成清晰的四节点路由结构。主标志、横向组合与单色版本位于 `apps/web/public/brand/`。

横向组合的英文字标使用圆角笔形的矢量轮廓，以较柔和的字形平衡图形标志的机械感。字标视觉高度与 64px 图形标志基本一致，避免横向组合中名称显得偏小。SVG 内不包含 `<text>` 或字体依赖，保证各运行环境的品牌呈现一致。

正式方向采用 `01-rounded-branch`。品牌图形坚持纯色、无渐变、无纹理；标准底板圆角为 16/64，白色路由线宽为 6/64，并需在 64px 尺寸下保持入口、分流和四个节点可辨。

## Color tokens

所有语义颜色在 `apps/web/src/styles.css` 的 Tailwind `@theme` 中使用 OKLCH 维护。页面优先使用 Tailwind utility，跨页面重复的控件样式才进入 `components` layer。

- `--canvas`: 外层中性画布，只用于承托产品窗口。
- `--surface`: 应用主体背景。
- `--surface-raised`: 数据面板、表格和输入表面。
- `--ink`: 主文本与强对比区域。
- `--accent`: 主操作、选中状态和重要调度节点。禁止作为无意义装饰。
- `--success`, `--warning`, `--danger`: 仅表示真实状态。

## Shape and elevation

- 页面框架和大面板：16px。
- 普通控件和内容容器：8px 或 12px。
- 控件：8px；内容卡片：12px；大面板与页面区域：16px。
- Badge、状态点和开关可以使用 full pill 或圆形。
- 面板默认无阴影，以背景层级区分；仅最外层产品窗口使用轻微 8px 内的阴影。

## Typography

使用系统 sans 字体栈。界面标签不使用展示字体。页面标题按视口使用 36–48px，模块标题 18px，正文 14px，数据使用紧凑字距。标题字距不得低于 `-0.05em`。

## Components

复用的页面级原语位于 `apps/web/src/pages.tsx`，应用壳、鉴权边界和共享数据上下文位于 `apps/web/src/App.tsx`：

- `Header`: 页面标题、说明和动作区。
- `Card`: 大面板与数据区域。
- `Status`: 状态文本与语义颜色。
- `Empty`: 空数据与下一步说明。
- `ConsoleContext`: snapshot 缓存、刷新与统一鉴权 API。

所有交互组件必须覆盖默认、hover、focus-visible、active、disabled；加载状态保留原布局尺寸，不使用居中大 spinner。

## Page architecture

- `/app/connect`：Admin Token 接入，Token 只存浏览器 sessionStorage。
- `/app`：运行概览。
- `/app/subscriptions`：订阅管理。
- `/app/proxies`：代理管理。
- `/app/sessions`：活跃会话。
- `/app/playground`：快捷操作 Playground。
- `/app/docs`：使用文档。
- 概览：网关地址、关键指标、节点分布和最近活动。
- 订阅管理：远程和本地订阅、revision 状态、刷新与异常缩减保护。
- 代理管理：节点健康、延迟、会话数、调度权重、启停。
- 活跃会话：仅展示 HMAC 身份摘要、模式、绑定节点和连接计数。
- Playground：生成调度用户名与 cURL，请求结果与常用配方。
- 使用文档：部署、认证、调度模式、健康和指标。

所有认证页面由 React Router 的 `/app` 父路由承载。桌面使用左侧中部的窄型图标 rail；移动端变为包含文字标签的遮罩抽屉。页面不使用面包屑，也不出现头像、用户名、账户菜单、登录状态或退出按钮。

## Authentication boundary

接入通过带 `Authorization: Bearer <admin-token>` 的 `/console/snapshot` 请求验证。`createApiClient` 为所有管理请求附加同一鉴权头，401 会清除 sessionStorage 并返回 `/app/connect`。`/live` 与 `/ready` 是基础设施探针，不返回管理数据；其余管理接口必须鉴权。代理数据面继续使用独立 Proxy Token，不能与 Admin Token 复用。Playground 的 Proxy Token 输入只存在组件内存，生成命令始终使用 `$PROXY_TOKEN`。

## Responsive behavior

- ≥1024px：左侧中部纯图标 rail 与宽数据工作区。
- <1024px：rail 变为有文字标签的模态抽屉，页面卡片按可用宽度折叠。
- 表格保留最小宽度并横向滚动；窄屏动作区、指标与快捷配方纵向堆叠。

## Accessibility

正文与表单占位文本至少满足 WCAG AA。所有仅图标按钮必须有可访问名称，键盘焦点使用统一橙红 focus ring。减少动态偏好会把过渡时间降至近乎即时。
