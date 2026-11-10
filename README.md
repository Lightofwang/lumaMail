# Luma Mail

基于 Tauri 2 + React 19 的跨平台邮件客户端，通过标准 IMAP/SMTP 协议收发邮件。

> 产品暂定名 Luma Mail，可自由更名。

## 技术栈

- **桌面框架**：Tauri 2.12.5（Rust 后端 + WebView2 前端）
- **前端**：React 19 + TypeScript + Vite 6
- **样式**：Tailwind CSS v4（CSS-first，`@theme` 定义 token）
- **状态管理**：Zustand 5
- **动画**：Motion（motion/react）
- **图标**：Lucide React
- **富文本编辑器**：TipTap 3（contentEditable）
- **日期处理**：date-fns 4
- **HTML 净化**：DOMPurify 3
- **邮件协议（Rust）**：imap 2.4、lettre 0.11、mail-parser 0.11、keyring 3.6、native-tls

## 运行命令

### 开发模式（仅前端，在浏览器中查看）

> 浏览器中没有 Tauri IPC，账号与邮件功能不可用，界面会以空邮箱状态展示。

```bash
# 确保使用 Node 22
eval "$(fnm env --shell bash)" && fnm use 22

# 安装依赖
npm install

# 启动前端开发服务器
npm run dev
# → http://localhost:1420
```

### 开发模式（Tauri 桌面应用）

```bash
# Windows：需要先设置 MSVC 环境
# 方法一：在 VS Developer Command Prompt 中运行
npm run tauri dev

# 方法二：使用批处理
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
npx tauri dev
```

### 构建

```bash
# 前端构建
npm run build

# Rust 后端构建（必须先进入 MSVC 环境，否则 Git 的 link.exe 会抢占链接器）
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
cd src-tauri
cargo build --release

# Tauri 桌面应用构建（debug 模式，不打包安装程序）
npx tauri build --debug --no-bundle
# → src-tauri/target/debug/luma-mail.exe
```

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `j` / `k` | 上/下移动选择邮件 |
| `Enter` | 打开选中邮件 |
| `c` | 撰写新邮件 |
| `r` | 回复选中邮件 |
| `e` | 归档选中邮件 |
| `s` | 星标/取消星标 |
| `/` | 聚焦搜索框 |
| `Ctrl/Cmd + K` | 打开命令面板 |
| `Ctrl/Cmd + N` | 撰写新邮件 |
| `Esc` | 关闭浮层/取消选择 |

> 注：输入框聚焦时，单键快捷键自动禁用。

## 已实现功能

### 账号与服务器

- [x] 账号表单：Gmail / 126 / 163 / QQ / 腾讯企业邮 / 阿里云企业邮 / 自定义 IMAP+SMTP
- [x] 先测试后保存：提交时先调用 `account_test` 验证 IMAP 与 SMTP 登录，成功后才写入 `account_save`
- [x] 表单内联中文错误：邮箱或密码/授权码不正确、未开启 IMAP、证书错误、网络不可达、连接超时
- [x] 账号配置写入应用数据目录的 `accounts.json`，**不包含密码字段**
- [x] 密码/授权码写入系统凭据管理器（Windows 凭据管理器 / macOS 钥匙串），通过 `keyring` 读写
- [x] 设置 → 账号：查看账号、切换当前账号、删除账号（同时清除凭据与本地缓存）
- [x] 设置 → 服务器：展示真实的 IMAP/SMTP 地址、端口、加密方式与用户名

### 邮件

- [x] 启动时从后端加载账号与文件夹；无账号时显示空邮箱引导
- [x] 按文件夹分页拉取（首次 30 封），滚动到底部自动加载更多
- [x] 邮件列表分组、未读加粗、附件标记、星标标记
- [x] 打开邮件按需拉取正文（`message_get`），支持 HTML 与纯文本
- [x] 打开邮件自动标记已读（`message_set_flags`），未读数实时更新
- [x] 星标/取消星标写回服务器，星标文件夹为虚拟文件夹
- [x] 归档（移动到 Archive）与删除（移动到垃圾箱）走真实 IMAP 命令
- [x] 撰写并发送：`message_send` 通过 SMTP 发送；发送成功后刷新已发送文件夹
- [x] 附件下载：保存到系统下载目录并提示保存路径
- [x] 搜索、未读/有附件筛选作用于当前文件夹已加载的邮件
- [x] 本地草稿：撰写弹窗可保存到本地草稿文件夹，刷新后保留

### 安全

- [x] IMAP 强制 SSL/TLS（隐式 TLS，默认证书校验，不提供跳过证书校验的开关）
- [x] SMTP 仅接受 SSL/TLS 或 STARTTLS，拒绝明文连接
- [x] 错误信息经过脱敏处理，不会回显密码/授权码
- [x] 邮件 HTML 正文先经 DOMPurify 净化再渲染，移除脚本、iframe、表单、样式表链接
- [x] 远程图片默认不加载（防追踪像素），阅读面板提供「显示图片」手动按钮
- [x] 正文中的外部链接统一 `target="_blank"` + `rel="noopener noreferrer nofollow"`
- [x] 非 Tauri 环境（浏览器直接打开）不会调用后端，优雅降级为空邮箱

### 界面

- [x] 三栏布局：侧边栏（248px，可折叠为 72px）+ 邮件列表（360px）+ 阅读面板（自适应，最大行宽 680px）
- [x] 空邮箱引导：侧栏、邮件列表、阅读面板均提示添加账号后开始收发邮件
- [x] 加载骨架屏、列表错误态与重试、正文加载失败重试、操作 toast
- [x] 命令面板（Ctrl+K）：文件夹跳转、账号切换、撰写、密度设置
- [x] 设置面板：外观（密度/字号）、签名（暂未接入服务器）、账号管理、服务器配置
- [x] 响应式：< 1100px 阅读面板覆盖层，< 900px 侧边栏自动折叠

## 后端命令

| 命令 | 说明 |
|------|------|
| `account_list` | 读取 `accounts.json` 中的账号（不含密码） |
| `account_test` | 同时验证 IMAP 与 SMTP 登录 |
| `account_save` | 保存账号配置并写入系统凭据管理器 |
| `account_delete` | 删除账号配置与凭据 |
| `folder_list` | 列出文件夹及未读数 |
| `message_list` | 按文件夹分页拉取邮件摘要（`__starred__` 为虚拟星标文件夹） |
| `message_get` | 拉取单封邮件正文与附件信息 |
| `message_set_flags` | 更新 `seen` / `flagged` 标志 |
| `message_move` | 移动邮件到目标文件夹 |
| `message_delete` | 移至垃圾箱 |
| `message_send` | 通过 SMTP 发送（自行托管的服务器会 APPEND 到已发送） |
| `attachment_save` | 保存附件到指定目录或系统下载目录 |

所有阻塞网络操作都在 `spawn_blocking` 中执行；连接超时 15 秒。每个命令独立建立连接并在结束后关闭。

## 状态持久化

- **持久化键**：`luma-mail-state-v3`（localStorage）
- **启动清理**：自动移除旧键 `luma-mail-state-v2` 与 `luma-mail-state`
- **持久化内容**：
  - 本地草稿
  - 外观设置：密度、字号、侧边栏折叠状态
  - 上次选中的账号 id
- **不持久化**：账号配置（在 `accounts.json`）、密码/授权码（在系统凭据管理器）、邮件正文（每次按需从服务器拉取）
- **重置方式**：设置 → 外观 → 「清空本地数据」，删除账号配置、凭据、本地草稿与偏好
- **兼容性**：持久化数据损坏或不可用时静默回退到空状态，不会白屏

## 已知限制

| 项目 | 说明 |
|------|------|
| OAuth 认证 | 仅支持密码/授权码登录；Gmail 需使用应用专用密码，QQ/163/126 需使用授权码 |
| 撰写附件 | 发送端附件选择尚未接入（需要 Tauri dialog 插件），收件附件可正常下载 |
| 搜索范围 | 只搜索当前文件夹中已加载的邮件，不是服务器端全量搜索 |
| 签名 | 签名编辑尚未写入服务器或草稿，保存按钮会提示后续版本接入 |
| 草稿 | 草稿仅保存在本地，不会同步到服务器 Drafts 文件夹 |
| 邮件正文缓存 | 每次打开邮件都重新从服务器拉取，无离线缓存 |
| 深色主题 | 仅浅色主题 |
| 正文样式 | 净化时会移除 `<style>` 与外部样式表，邮件排版可能与网页端有差异 |

## 环境说明

- 本机开发环境的代理会阻断 `smtp.gmail.com` 的 465/587 端口（TLS 握手读到 0 字节），因此 Gmail 账号的 SMTP 测试在该网络下会失败。这是网络环境限制，代码不会降级或跳过 TLS；真实发信请在可直连 SMTP 端口的网络下验证。
- IMAP 连接超时 15 秒；网络不可达时表单会给出「无法连接服务器」类错误。

## 目录结构

```
luma-mail/
├── src/
│   ├── components/       # UI 组件
│   │   ├── Sidebar.tsx
│   │   ├── MailList.tsx
│   │   ├── ReadingPanel.tsx
│   │   ├── ComposeModal.tsx
│   │   ├── CommandPalette.tsx
│   │   ├── AccountSetupModal.tsx
│   │   ├── SettingsPanel.tsx
│   │   ├── Toast.tsx
│   │   └── SkeletonLoader.tsx
│   ├── hooks/
│   │   ├── useKeyboardShortcuts.ts
│   │   └── useWindowWidth.ts
│   ├── lib/
│   │   ├── mailApi.ts     # Tauri 命令封装与错误映射
│   │   ├── providers.ts   # 服务商预设
│   │   ├── sanitizeHtml.ts# DOMPurify 净化与远程图片拦截
│   │   └── utils.ts
│   ├── store/
│   │   └── mailStore.ts   # Zustand 全局状态与后端适配
│   ├── types/
│   │   └── index.ts
│   ├── App.tsx
│   ├── main.tsx
│   ├── index.css
│   └── vite-env.d.ts
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── mail/          # accounts/credentials/imap/smtp/error 等模块
│   ├── icons/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── build.rs
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```
