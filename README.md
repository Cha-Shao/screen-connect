# ScreenConnect

WebRTC 语音聊天 + 屏幕共享应用。Server 部署在公网机器做信令服务器，Client 连接后从房间列表中选一个加入。

- 语音通话 + 屏幕共享，支持 **720p / 1080p**、**30 / 60fps** 可选
- 房间列表制：服务器用 `config.yaml` 配置房间，客户端连接后看到列表，选一个加入
- 机器码作为唯一 ID（不可改），昵称在连接前设置
- **语音降噪**：支持 RNNoise（深度学习 WASM）和 WebRTC ANS 两种引擎
- **语音转写（ASR）**：房间级开关，默认本地 Vosk 离线转写（可切 whisper / 阿里云百炼）+ 时间轴日志 + TXT 下载（桌面端弹系统「另存为」选择保存位置）/服务端落盘
- **DaisyUI** 界面，持久侧栏显示房间列表 + 大厅用户 + 拖拽移动用户
- **Tauri 桌面端**（Windows/macOS/Linux），同时提供浏览器备用入口
- 用户加入 / 退出提示音（升调 / 降调）
- 自建 STUN + TURN 服务器，跨互联网 NAT 穿透

## 架构

```
server/   Node.js 信令服务器（公网机器）  —— WebSocket 信令 + 房间管理 + 静态托管前端 + ICE 配置下发
ui/      共用前端（React + Vite）        —— WebRTC 逻辑，浏览器与 Tauri 共用
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
# 只监听本机回环（内网模式 + 反代时用）：在 config.yaml 里设置
#   host: "127.0.0.1"
# 默认 host: "0.0.0.0"（监听所有网卡，公网直连）
```

启动后控制台会显示：
```
已加载 N 个房间: 大厅, 技术交流, ...
screen-connect 信令服务器已启动: http://0.0.0.0:1454   # host 为 127.0.0.1 时显示 http://127.0.0.1:1454
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

  **内网模式（推荐给反代）：** 反代程序和信令服务器在同一台机器时，服务器无需对外监听，
  在 `config.yaml` 里设 `host: "127.0.0.1"` 后启动，只绑本机回环，外部无法直连 1454 端口，只能走反代。
  Nginx 示例（注意 WebSocket 升级头，`/ws` 路径必须代理）：
  ```nginx
  server {
      listen 443 ssl;
      server_name your.domain.com;
      # ssl_certificate / ssl_certificate_key ...

      location / {
          proxy_pass http://127.0.0.1:1454;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }

      location /ws {
          proxy_pass http://127.0.0.1:1454;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_read_timeout 3600s;
      }
  }
  ```

> 注意：服务器只跑信令，不承载媒体流量，所以带宽要求很低。媒体走 P2P 或 TURN 中继。

## 二、使用客户端

### 方式 A：浏览器（最快体验）
服务器启动后，浏览器打开 `http://<公网IP>:1454`（或你反代的 HTTPS 域名），
填服务器地址（不写端口时默认 1454）、昵称，点"连接服务器"，从房间列表中选一个加入即可。

**前端本地开发（热重载）**：仓库根目录执行
```bash
pnpm install
pnpm dev:ui          # 启动 Vite dev server（改代码即时热更新）
```
浏览器打开 `http://localhost:5173`，在登录页填信令服务器地址即可联调；`pnpm dev:server` 可同时起信令服务器（静态托管 `ui/dist` 构建产物；未构建时返回引导页提示先运行 `pnpm build:ui`，React 源码不能由 Node 直接运行）。

> **构建产物（`ui/dist`）必须通过 HTTP 访问**，不能直接双击 `index.html` 用 `file://` 打开——Vite 产物里是绝对路径（`/assets/index-*.js|css`），`file://` 下会找不到，表现为**只有加载动画、页面空白无样式**。两种访问方式：
> - **完整功能**（信令 + 静态托管，推荐）：`pnpm dev:server` → `http://localhost:1454`（公网部署同理，服务器自身就是静态服务器，无需再挂 Nginx 托管前端）
> - **只看前端界面**（无信令后端）：`pnpm preview:ui` → `http://localhost:4173`
>
> 另注意：`pnpm build:ui` 如果被中断（或 dist 被部分拷贝），会出现 `index.html` 与 `dist/assets` 里 hash 文件名对不上、同样表现为无样式的情况，重新完整构建一次即可。运行中的信令服务器每次请求都会重新探测 `ui/dist`，构建完成后**无需重启**。

### 方式 B：Tauri 桌面端（推荐，机器码为真实硬件 ID）

#### 前置
- [Rust](https://rustup.rs/) 工具链（stable）
- [Node.js](https://nodejs.org/) 16+ 和 pnpm
- Windows：WebView2 Runtime（Win11 自带）；macOS：Xcode CLI；Linux：webkit2gtk 等系统依赖（见 Tauri 官方前置说明）

#### 构建
```bash
pnpm install
cd client
pnpm build          # 即 tauri build，自动先构建 ui/dist，产物在 src-tauri/target/release
```
打包后的安装包（NSIS）位于 `client/src-tauri/target/release/bundle/nsis/`。

#### 开发模式（热重载）
```bash
cd client
pnpm dev            # tauri dev：自动启动 Vite dev server（5173），前端改动即时热更新
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
| 语音转写 | 房间内点"📝 转写"开启/关闭 ASR：系统行"语音转写开启/关闭 HH:MM" + 时间轴"用户A：大家吃饭没有 11:46"；每次开关为一个 group，日志窗口可随时下载 TXT（从开始到目前；Tauri 桌面端会弹系统「另存为」窗口选择保存位置，浏览器端走普通下载），服务端按 `房间-开始-结束.txt` 落盘 |
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

## 五、ASR 语音转写（可选）

使用**本地 whisper.cpp（base 模型）**转写，不依赖任何云端 ASR API。

### 1. 安装 whisper（服务器上）

**Debian / Ubuntu（推荐，与信令服务器同机）：**

```bash
cd server
sudo apt install -y curl unzip git cmake build-essential
bash setup-whisper.sh
```

脚本按顺序尝试：① GitHub 最新 release 的 Linux 预编译包 → ② 固定版本 v1.7.6 预编译包 → ③ 源码编译 whisper.cpp（最可靠）。模型 `ggml-base.bin` 依次从 GitHub release 资产 / HuggingFace / hf-mirror（国内镜像）获取，全部失败时提示手动下载。也可指定版本：`WHISPER_TAG=v1.7.6 bash setup-whisper.sh`。

> ⚠️ **脚本失败 / 服务器无外网？** 见 [server/setup-whisper-MANUAL.md](server/setup-whisper-MANUAL.md)——完整的手动安装指南（另一台能上网的电脑下载 → 传到服务器），含常见错误对照表（404、缺 libwhisper.so.1、误用 .exe 等）。

**Windows：**

```bash
cd server
powershell -ExecutionPolicy Bypass -File setup-whisper.ps1
```

脚本会下载 `whisper-cli`（whisper.cpp 官方预编译包）和 `ggml-base.bin`（约 75MB）到 `server/whisper/`。也可以手动编译 whisper.cpp 并把 `whisper-cli` 放进 PATH，或在 `config.yaml` 里指定路径。

### 2. 配置

`server/config.yaml`：

```yaml
asr:
  enabled: true            # 开启 ASR 功能
  mode: "local-vosk"       # 默认转写引擎：local-vosk（推荐）| local-whisper | aliyun-bailian
  logDir: "logs"           # 落盘目录，文件名 房间-开始-结束.txt

  # 本地 whisper（mode: "local-whisper" 时使用）
  whisper:
    bin: "whisper/whisper-cli"
    model: "whisper/ggml-base.bin"
    language: "zh"         # 语言，留空自动检测
    threads: 4

  # 本地 Vosk（离线识别，免费；需安装 vosk 模块 + 模型）
  vosk:
    modelDir: "vosk/vosk-model-small-cn-0.22"   # 解压后的模型目录

  # 阿里云百炼（qwen-audio-3.0-asr-flash，约 0.00022 元/秒；需要 mode: "aliyun-bailian"）
  aliyun:
    apiKey: ""             # 百炼 API Key（或环境变量 DASHSCOPE_API_KEY）
    workspaceId: ""        # 百炼控制台 workspace-id（按地域区分，换 region 需换该地域的 id）
    model: "qwen-audio-3.0-asr-flash"  # 多模态语音识别模型（multimodal-generation 接口）
    region: "cn-beijing"   # 华北2北京；服务器在华南（广州）可选 cn-shenzhen（需开通并换 workspace-id）
    audioDir: "asr-audio"  # 失败音频保留目录（转写失败时写入，便于试听/排查）
    parameters: {}         # 转写参数，默认 { format: "mp3", sample_rate: "16000" }（实测可用写法，别加无关参数否则 400）
    baseUrl: ""            # 留空自动拼接，代理/测试可覆盖

  # 人声门控（可选，推荐）：送 ASR 前先用本地 Silero VAD 判断有没有人声，
  # 鼓掌/环境音等无语音内容的音频直接丢弃（省阿里云费用、避免"无内容 400 {}"）。
  # 安装：bash setup-silero-vad.sh（下载 silero/silero_vad.onnx ~2MB + 安装 onnxruntime-node）
  speechGate:
    enabled: true          # 依赖缺失时自动放行全部音频，不影响正常转写
    mode: "silero"
    model: "silero/silero_vad.onnx"
    threshold: 0.5         # 单帧语音概率阈值
    minSpeechMs: 300       # 一句话里最少"判定为语音"的毫秒数
    minSpeechRatio: 0.15   # 语音时长占整句比例下限
```

三种引擎由**服务器 config.yaml 统一决定**（客户端不可选，📝 转写按钮会显示当前引擎及是否可用）：

| 引擎 | 说明 | 费用 |
| --- | --- | --- |
| `local-vosk`（默认） | 服务器本地 Vosk 离线识别，CPU 占用低、响应快 | 免费 |
| `local-whisper` | 服务器本地 whisper.cpp base 模型 | 免费，中文质量一般 |
| `aliyun-bailian` | 阿里云百炼 qwen-audio-3.0-asr-flash（多模态接口，音频 base64 内联） | 约 0.00022 元/秒 |

> **阿里云引擎注意**：qwen-audio-3.0-asr-flash 走**多模态 generation 接口**（`/api/v1/services/aigc/multimodal-generation/generation`），每句话的 WAV 直接 base64 内联发送（`data:audio/wav;base64,...`），**不需要公网 URL、不需要服务器暴露音频路由**；默认同步调用，短音频直接返回文本，出错时日志会打印完整响应体。若报 `403 AccessDenied`（如 `does not support synchronous calls`），通常是 **API Key 与业务空间/地域不匹配、语音识别服务未开通或 Key 类型受限**，需要到百炼控制台（API-KEY 管理 + 模型开通）处理。地域默认 `cn-beijing`（与 workspace-id 匹配）；服务器在广州的话，若已在百炼开通华南地域，可改用 `region: cn-shenzhen` 并把 `workspaceId` 换成该地域的。

> **无语音内容的 400 {}**：鼓掌/环境音这类非人声经过能量 VAD 也会被送去转写，百炼对"没有语音内容"的音频返回 **HTTP 400 + 空响应体 `{}`**。引擎已把这种响应视为"无内容"静默忽略（不告警、不保存失败音频）。更彻底的做法是开上面的人声门控（Silero VAD），在送 ASR **之前**就把非人声丢弃。

> `asr.enabled: false` 时服务器不支持开转写，客户端按钮会置灰并提示"服务器未启用语音转写"；引擎未安装/未配置就绪时按钮可点但会提示具体原因。

**人声门控安装**（可选；开 `speechGate.enabled: true` 前先跑）：
```bash
cd server
bash setup-silero-vad.sh     # Linux：下载 silero/silero_vad.onnx + npm install onnxruntime-node --no-save
# Windows: powershell -ExecutionPolicy Bypass -File setup-silero-vad.ps1
node test-silero-gate.js     # 自测：真实人声判为有人声，白噪声/静音判为无人声
```

**Vosk 安装**（服务器能访问 npm 时）：
```bash
cd server
npm install vosk --no-save
# 下载模型并解压到 server/ 下（目录名 = modelDir）：
#   小模型 中文 ~42MB:  https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
#   大模型 中文 ~1.4GB: https://alphacephei.com/vosk/models/vosk-model-cn-0.22.zip
```
不能访问 npm 时：在有网的 Linux/WSL 里对 `server` 目录执行同样的 `npm install vosk --no-save`，再把 `node_modules/vosk` 整个目录传到服务器（vosk 是平台相关原生模块，必须 Linux x64 版，Windows 上装的不能用）。

### 3. 使用

1. 客户端进入房间后，点底部 **📝 转写**（引擎由服务器 config 决定，悬停按钮可见）开启。
2. 房间内所有人自动弹出**转写日志窗口**（标题标注当前引擎）：系统行 `语音转写开启 11:45`，时间轴 `用户A：大家吃饭没有 11:46`；侧栏房间列表显示 **ASR** 徽标。
3. 随时点日志窗口 **⬇ TXT** 下载从开始到目前的全部内容（转写开关状态都不影响下载）。
4. 再点 **📝 转写中** 关闭，日志写入 `语音转写关闭 13:22`，本次开关为一个 group；服务端把该 group 落盘为 `logs/大厅-2024-01-15_11-45-00-2024-01-15_13-22-30.txt`。
5. 中途加入房间的成员会自动收到已有历史；房间空无一人时转写自动关闭并落盘。

> ⚠️ **隐私提示**：ASR 开启期间，房间内成员的麦克风音频会上传到服务器做转写（平时语音仍走 P2P，服务器听不到）。请确保房间成员知情同意。

## 六、目录结构
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
│   ├── asr.js             # ASR 模块（VAD + 人声门控 + whisper/vosk/阿里云引擎 + 会话落盘）
│   ├── setup-whisper.sh   # Debian/Ubuntu 一键安装（whisper-cli + ggml-base.bin）
│   ├── setup-whisper.ps1  # Windows 一键安装
│   ├── setup-silero-vad.sh    # 人声门控安装（silero_vad.onnx + onnxruntime-node）
│   ├── setup-silero-vad.ps1   # Windows 人声门控安装
│   ├── test-silero-gate.js    # 人声门控自测
│   ├── logs/              # 转写日志（房间-开始-结束.txt）
│   ├── whisper/           # whisper 程序与模型（setup 脚本生成）
│   ├── silero/            # Silero VAD 模型（setup 脚本生成，~2MB）
│   ├── .env               # PORT 等环境变量（可选）
│   └── run.bat            # Windows 快速启动
├── ui/                     # 共用前端（React + Vite，浏览器与 Tauri 共用）
│   ├── index.html          # 入口（splash + React 挂载点）
│   ├── vite.config.ts      # Vite 配置（Tauri devUrl 热重载 5173）
│   ├── tsconfig.json       # TypeScript 配置
│   ├── tailwind.config.js  # Tailwind + DaisyUI（night 主题）
│   ├── public/
│   │   ├── rnnoise.wasm       # RNNoise 降噪 WASM 模型
│   │   └── rnnoise.worklet.js # AudioWorklet 处理器
│   └── src/
│       ├── main.tsx        # React 入口
│       ├── App.tsx         # 应用骨架（登录/主界面切换）
│       ├── engine.ts       # 核心引擎：WebRTC/信令/降噪/ASR/说话检测（无框架依赖）
│       ├── hooks.ts        # useEngine 快照订阅
│       ├── globals.d.ts    # 全局类型（Tauri 桥 / vite/client）
│       ├── index.css       # Tailwind 指令 + 自定义动画/状态样式
│       └── components/     # Lobby / Sidebar / Stage / PeerCard / Controls /
│                           # TranscriptWindow / Modal / Toast 等 React 组件（TSX）
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

## 七、信令协议（JSON）

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
| → 服务器 | `asr-toggle` `{on}` | 开启/关闭当前房间语音转写 |
| ← 房间 | `asr-state` `{roomId, on, startTs\|endTs, file?}` | 转写开关状态（房间成员）；`file` 为关闭时的落盘文件名 |
| ← 全局 | `asr-badge` `{roomId, on}` | 侧栏房间列表 ASR 徽标更新 |
| ← 房间 | `asr-history` `{roomId, lines}` | 中途加入时的历史日志 |
| ← 房间 | `asr-line` `{roomId, t, kind, nickname?, text}` | 转写行（kind=sys 系统行 / user 用户行） |
| → 服务器 | 二进制帧 `[4B长度][JSON header][Int16LE PCM @16kHz]` | ASR 音频上传，header `{type:'asr-audio', room}` |

WebRTC 协商采用 Perfect Negotiation 模式，ID 小的一方为 polite（回滚让步），ID 大的一方为 impolite。
