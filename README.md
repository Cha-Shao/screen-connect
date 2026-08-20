# ScreenConnect

WebRTC 语音聊天 + 屏幕共享应用。Server 部署在公网机器做信令服务器，Client 连接后从房间列表中选一个加入。

- 语音通话 + 屏幕共享，支持 **720p / 1080p**、**30 / 60fps** 可选
- 房间列表制：服务器用 `config.yaml` 配置房间，客户端连接后看到列表，选一个加入
- 机器码作为唯一 ID（不可改），昵称在连接前设置
- **语音降噪**：支持 RNNoise（深度学习 WASM）和 WebRTC ANS 两种引擎
- **DaisyUI** 界面，持久侧栏显示房间列表 + 大厅用户 + 拖拽移动用户
- **Tauri 桌面端**（Windows/macOS/Linux），同时提供浏览器备用入口
- 用户加入 / 退出提示音（升调 / 降调）
- 自建 STUN + TURN 服务器，跨互联网 NAT 穿透

## 架构

```
server/   Node.js 信令服务器（公网机器）  —— WebSocket 信令 + 房间管理 + 静态托管前端 + ICE 配置下发
shared/   共用前端（HTML/CSS/JS）         —— WebRTC 逻辑，浏览器与 Tauri 共用
          rnnoise.wasm / rnnoise.worklet.js —— RNNoise 降噪 WASM 模型
client/   Tauri 桌面端                    —— Rust 生成机器码 + 内嵌前端
```

WebRTC 采用 P2P mesh 拓扑：每个客户端与房间内其他人直连，音视频流点对点传输，服务器只负责信令中转（不转发媒体流）。适合 2~6 人小房间。

## 一、部署信令服务器（公网机器）

### 1. 安装 Node.js 16+ 和 pnpm

### 2. 安装依赖
```bash
pnpm install
```

### 3. 配置房间和 ICE 服务器
```bash
cp server/config.example.yaml server/config.yaml
```
编辑 `server/config.yaml`（此文件已被 gitignore，不会提交凭据）：

```yaml
# ICE 服务器配置（STUN + TURN，自建 coturn）
iceServers:
  - urls: "stun:your.coturn.host:3478"
  - urls: "turn:your.coturn.host:3478"
    username: "youruser"
    credential: "yourpass"
  - urls: "turn:your.coturn.host:3478?transport=tcp"
    username: "youruser"
    credential: "yourpass"

# 房间列表（name 同时作为唯一标识，无需 id）
rooms:
  - name: 大厅
  - name: 技术交流
  - name: 摸鱼角
```

ICE 配置由服务器统一下发，客户端自动获取，无需在客户端硬编码。

### 4. 启动
```bash
cd server
pnpm start            # 默认端口 1454
# 自定义端口：
PORT=9000 pnpm start
```

启动后控制台会显示：
```
已加载 N 个房间: 大厅, 技术交流, ...
screen-connect 信令服务器已启动: http://0.0.0.0:1454
WebSocket: ws://<公网IP>:1454/ws
```

### 5. 开放端口 / 防火墙
- 云厂商安全组：放行 **TCP 1454**（或你设的 PORT）入站。
- 服务器系统防火墙（Windows）：
  ```powershell
  New-NetFirewallRule -DisplayName "ScreenConnect" -Direction Inbound -Protocol TCP -LocalPort 1454 -Action Allow
  ```
- 若需要 HTTPS / WSS（强烈建议，否则部分浏览器拒绝共享屏幕/麦克风）：
  用 Nginx/Caddy 反代 1454 并配置 TLS 证书，例如 Caddy：
  ```
  your.domain.com {
    reverse_proxy localhost:1454
  }
  ```
  此时客户端地址填 `your.domain.com`，勾选 `wss`。

> 注意：服务器只跑信令，不承载媒体流量，所以带宽要求很低。媒体走 P2P 或 TURN 中继。

## 二、使用客户端

### 方式 A：浏览器（最快体验）
服务器启动后，浏览器打开 `http://<公网IP>:1454`（或你反代的 HTTPS 域名），
填服务器地址（不写端口时默认 1454）、昵称，点"连接服务器"，从房间列表中选一个加入即可。

### 方式 B：Tauri 桌面端（推荐，机器码为真实硬件 ID）

#### 前置
- [Rust](https://rustup.rs/) 工具链（stable）
- [Node.js](https://nodejs.org/) 16+ 和 pnpm
- Windows：WebView2 Runtime（Win11 自带）；macOS：Xcode CLI；Linux：webkit2gtk 等系统依赖（见 Tauri 官方前置说明）

#### 构建
```bash
cd client
pnpm install
pnpm build          # 即 tauri build，产物在 src-tauri/target/release
```
打包后的安装包（NSIS）位于 `client/src-tauri/target/release/bundle/nsis/`。

#### 开发模式
```bash
cd client
pnpm dev            # tauri dev，热加载前端
```

#### 运行
打开 ScreenConnect，填入信令服务器地址（如 `your.domain.com`）、昵称，连接后从房间列表选一个加入。

## 三、功能说明

| 功能 | 说明 |
| --- | --- |
| 机器码 ID | 桌面端取操作系统级唯一标识（Windows MachineGuid / macOS IOPlatformUUID / Linux machine-id），归一化为 `XXXX-XXXX-XXXX-XXXX`；浏览器端用本地存档伪机器码 |
| 服务器地址 | 只填 `域名` 或 `域名:端口`（不写端口默认 1454）；套了 TLS 反代时勾选 `wss` |
| 昵称 | 连接前在大厅设置 |
| 语音 | 自动获取麦克风，回声消除；底部按钮一键闭麦 |
| 麦克风选择 | 底部下拉框选择麦克风设备，热切换 |
| 语音降噪 | 🌊 按钮下拉选择：无降噪 / RNNoise（推荐，WASM 神经网络）/ WebRTC ANS（浏览器内置），默认关闭，记住选择 |
| 单人音量 | 右侧每个成员卡片独立音量条（0–100），互不影响 |
| 屏幕共享 | 分辨率可选 720p/1080p，帧率可选 30/60fps；编码码率自适应（720p 30fps→2Mbps ~ 1080p 60fps→6Mbps），优先保持帧率 |
| 共享者列表 | 右侧仅列出正在共享的人（只显名字，不显内容） |
| 播放/暂停 | 共享者卡片上点 ▶ 在卡内显示画面，⏸ 暂停隐藏 |
| 放大多选 | 点 ⤢ 把画面固定到左侧主舞台，可同时固定多个，并排放大观看 |
| 中途加入 | 新用户加入时自动同步已有共享状态，不遗漏 |
| 状态广播 | 谁在共享、谁闭麦，房间内实时显示标签 |
| 用户管理 | 持久侧栏显示房间列表 + 大厅用户；拖拽用户到其他房间移动；邀请大厅用户进入房间 |
| 提示音 | 用户加入播放升调（C5→E5→G5），退出播放降调（G5→E5→C5） |
| 退出 / 断开 | "退出房间"回到大厅（仍连服务器），"断开"完全下线，两个按钮互斥显示 |

## 四、NAT 穿透说明（重要）

P2P 跨网络需要 ICE。ICE 服务器配置在 `server/config.yaml` 的 `iceServers` 段，由服务器统一下发给客户端。

- **STUN**：用于获取公网地址，多数场景够用。
- **TURN**：当双方处于对称型 NAT（严格企业网 / 移动网络）时，需要 TURN 中继媒体流。

推荐自建 [coturn](https://github.com/coturn/coturn)，然后在 `config.yaml` 中配置：
```yaml
iceServers:
  - urls: "stun:your.coturn.host:3478"
  - urls: "turn:your.coturn.host:3478"
    username: "user"
    credential: "pass"
  - urls: "turn:your.coturn.host:3478?transport=tcp"
    username: "user"
    credential: "pass"
```

## 五、目录结构
```
screen-connect/
├── package.json           # pnpm workspace 根
├── pnpm-workspace.yaml
├── .gitignore
├── README.md
├── server/
│   ├── package.json
│   ├── config.example.yaml # 配置模板（免费 STUN/TURN + 房间示例）
│   ├── config.yaml        # 实际配置（gitignore，含你的 TURN 凭据）
│   ├── server.js          # 信令服务器
│   ├── .env               # PORT 等环境变量（可选）
│   └── run.bat            # Windows 快速启动
├── shared/                # 共用前端
│   ├── index.html
│   ├── app.js             # WebRTC + UI 逻辑
│   ├── style.css
│   ├── rnnoise.wasm       # RNNoise 降噪 WASM 模型
│   └── rnnoise.worklet.js # AudioWorklet 处理器
└── client/                # Tauri 桌面端
    ├── package.json
    ├── app-icon.png
    └── src-tauri/
        ├── Cargo.toml
        ├── tauri.conf.json
        ├── build.rs
        ├── capabilities/default.json
        ├── icons/
        └── src/{main.rs,lib.rs}
```

## 六、信令协议（JSON）

客户端 ↔ 服务器（WebSocket `/ws`）：

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| ← 服务器 | `room-list` `{rooms, iceServers}` | 连接后自动下发，含房间列表 + ICE 配置 |
| → 服务器 | `get-rooms` `{}` | 请求刷新房间列表（服务器重读 YAML） |
| → 服务器 | `join` `{room, nickname}` | 加入房间 |
| ← 服务器 | `joined` `{room, you, nickname, peers}` | 加入成功，peers 含每个成员的 sharing 状态 |
| → 房间 | `peer-joined` `{peer:{id, nickname}}` | 新成员加入通知 |
| → 服务器 | `signal` `{to, data}` | WebRTC 信令中继（offer / answer / ICE candidate） |
| ← 服务器 | `signal` `{from, data}` | 转发的信令 |
| → 服务器 | `share-state` `{sharing, muted}` | 广播共享 / 静音状态（服务器跟踪 sharing） |
| ← 房间 | `share-state` `{id, sharing, muted}` | 状态标签更新 |
| → 服务器 | `nickname` `{nickname}` | 修改昵称 |
| → 服务器 | `leave-room` `{}` | 退出房间回大厅 |
| → 服务器 | `move-user` `{userId, room}` | 拖拽移动用户到其他房间 |
| → 服务器 | `invite` `{userId, room}` | 邀请大厅用户进入房间 |
| ← 全局 | `user-list` `{users}` | 全局用户列表（谁在哪个房间） |
| ← 房间 | `peer-left` `{id}` | 成员离开通知 |

WebRTC 协商采用 Perfect Negotiation 模式，ID 小的一方为 polite（回滚让步），ID 大的一方为 impolite。
