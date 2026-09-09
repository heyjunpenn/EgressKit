# EgressKit Design System

EgressKit 的产品界面服务于自托管代理控制面。当前 Web 控制台采用 beUI 的开放源码 Registry 模式：组件源码由 `https://beui.dev/r` 安装进项目，不增加 EgressKit 自绘组件皮肤。beUI Registry 未提供通用 Card 与 Textarea，因此这两项使用其基础层 shadcn 官方组件；页面只保留布局、排版和业务数据映射。

本次属于 Preserve redesign。URL、导航标签、表单字段、管理动作、Token 鉴权和数据结构保持不变，只统一视觉语言、状态反馈与响应式密度。设计参数为 `DESIGN_VARIANCE 3`、`MOTION_INTENSITY 5`、`VISUAL_DENSITY 8`。

## Brand idea

图形标志把一个入口、中心调度点和三个出口压缩为一个 64×64 几何符号。黑色圆角底表示稳定控制面，橙红色的中央决策节点与三个出口节点组成清晰的四节点路由结构。主标志、横向组合与单色版本位于 `apps/web/public/brand/`。

横向组合的英文字标使用圆角笔形的矢量轮廓，以较柔和的字形平衡图形标志的机械感。字标视觉高度与 64px 图形标志基本一致，避免横向组合中名称显得偏小。SVG 内不包含 `<text>` 或字体依赖，保证各运行环境的品牌呈现一致。

正式方向采用 `01-rounded-branch`。品牌图形坚持纯色、无渐变、无纹理；标准底板圆角为 16/64，白色路由线宽为 6/64，并需在 64px 尺寸下保持入口、分流和四个节点可辨。

## Color tokens

`apps/web/src/styles.css` 直接使用 beUI 官方 `theme.css` 的语义令牌，不定义项目级 `.field`、`.search-field`、`.table-wrap` 或组件覆写。

- `--background`: 整体中性画布。
- `--card`: 数据面板、表格和输入表面。
- `--foreground`: 主文本与深色反相区域。
- `--muted`, `--muted-foreground`: 次级表面与说明文字。
- `--border`, `--border-strong`, `--ring`: 描边、控件边界和键盘焦点。
- `--primary`: beUI 默认主操作与选中状态。
- `--success`, `--warning`, `--destructive`: 仅表示真实状态。

## Shape and elevation

- 页面框架和大面板：16px。
- 普通控件：12px；紧凑状态与小标签：6px 或 8px。
- Badge、状态点和开关可以使用 full pill 或圆形。
- 内容区域不使用卡片化背景、圆角、边框或阴影，通过间距、分栏和必要分隔线建立层级；只有顶部导航 Tabs 使用克制阴影。

## Typography

使用 Tailwind / 浏览器默认系统 sans 字体栈。界面标签不使用展示字体。产品采用紧凑固定字号阶梯：辅助文字 12px、次级界面 13px、正文 14px、模块标题 16–18px、页面标题 18–20px；字号令牌在 `styles.css` 统一维护，不逐组件覆写。页面标题使用静态语义 `h1`，不播放路由切换动画；模块标题沿用 shadcn `CardTitle`。页面标题下不显示说明文字。

## Components

beUI Registry 组件位于 `apps/web/src/components/motion/`，shadcn 基础组件位于 `apps/web/src/components/ui/`，Registry 共用工具位于 `apps/web/src/lib/`：

- `Tabs` / `TabsList` / `TabsTrigger`: 全站顶部图标加文字导航；工作台采用普通导航语义，不冒充 Tab panel。
- `Button`, `Input`, `Select`, `Switch`: 所有可交互控件。
- `AnimatedBadge`, `NumberTicker`, `Loader`: 状态、数据与加载反馈。
- `Table`: 订阅、节点与会话数据表。
- shadcn `Card`, `Textarea`: beUI 基础层缺失的结构容器与多行文本输入；Card 仅保留布局结构，不呈现卡片化视觉。
- `ConsoleContext`: snapshot 缓存、刷新与统一鉴权 API；它是业务上下文，不产生视觉样式。

所有交互组件必须覆盖默认、hover、focus-visible、active、disabled；Motion 动画只用于按压、状态变化与加载反馈，并尊重 `prefers-reduced-motion`。

## Page architecture

- `/app/connect`：Admin Token 接入，Token 只存浏览器 sessionStorage。
- `/app`：运行概览默认面板。
- `/app/subscriptions`、`/app/proxies`、`/app/sessions`、`/app/playground`：分别对应订阅管理、代理管理、活跃会话与快速操作面板。
- `/app/docs`：使用文档面板，按需懒加载。
- `/app#subscriptions`、`#proxies`、`#sessions`、`#playground`：旧版工作台锚点地址，进入后 replace 到对应 canonical Tab 路由；无效 hash 回到 `/app`。
- 每次只挂载当前 Tab 的内容，避免长页面同时渲染多个管理表格；共享 snapshot、refresh 与鉴权仍由 `/app` 父路由提供。
- 概览：使用单一紧凑工作面组织网关与指标摘要带、节点生命周期、连接采样和最近操作，不采用同尺寸指标卡片平铺。
- 订阅管理：远程和本地订阅、revision 状态、刷新与异常缩减保护。
- 代理管理：节点健康、延迟、会话数、调度权重、启停。
- 活跃会话：仅展示 HMAC 身份摘要、模式、绑定节点和连接计数。
- 快速操作：生成调度用户名与 cURL，请求结果与常用配方。
- 使用文档：部署、认证、调度模式、健康和指标。

所有认证页面由 React Router 的 `/app` 父路由承载。工作台使用统一的吸顶 Header：左侧显示 EgressKit Logo，中间为 beUI 路由导航 Tabs，右侧预留中文/英文语言选择；语言控件当前只切换本地选中状态，不执行翻译或持久化。导航项使用路由语义和 `aria-current="page"`，不冒充 ARIA tab panel。当前页面名称由导航状态和具名 main landmark 表达，各面板不再重复显示页面标题。窄屏 Header 分为品牌/语言与横向导航两行，桌面保持紧凑三栏布局。页面不使用面包屑，也不出现头像、用户名、账户菜单、登录状态或退出按钮。

## Authentication boundary

接入通过带 `Authorization: Bearer <admin-token>` 的 `/console/snapshot` 请求验证。`createApiClient` 为所有管理请求附加同一鉴权头，401 会清除 sessionStorage 并返回 `/app/connect`。`/live` 与 `/ready` 是基础设施探针，不返回管理数据；其余管理接口必须鉴权。代理数据面继续使用独立 Proxy Token，不能与 Admin Token 复用。Playground 不采集或保存 Proxy Token，生成命令仅显示字面量占位符 `PROXY_TOKEN`。

## Responsive behavior

- 所有视口：统一 Header 中的 beUI 导航 Tabs 图标与文字常驻显示；点击后切换到对应路由面板，文档与运营面板使用同一导航。语言选择位于导航滚动容器之外，避免下拉面板被裁剪。
- 粗指针设备：按钮、导航和选择器提供至少 44px 的触控区域；桌面细指针仍保持紧凑密度。
- 窄屏：卡片按可用宽度折叠。
- beUI Table 自行处理最小宽度、横向滚动与虚拟列表；窄屏动作区、指标与快捷配方纵向堆叠。

## Accessibility

正文与表单占位文本至少满足 WCAG AA。所有仅图标按钮必须有可访问名称，键盘焦点使用 beUI 语义 ring。Registry motion 组件统一尊重 `prefers-reduced-motion`。
