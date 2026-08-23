# screen-connect ASR 手动安装指南（setup 脚本失败时的兜底方案）

> **什么时候需要看这份文档**：`setup-whisper.sh` / `setup-whisper.ps1` 运行失败、
> 服务器没有外网（如国内云服务器）、下载被墙、或者你想完全手动控制。
>
> **典型场景**：Debian 12 服务器在机房/云上（无外网或访问 GitHub/HuggingFace 困难），
> 另有一台**能上网的电脑**（Windows 或 Linux 都行）负责下载，再传到服务器。

---

## 0. 先搞清楚两件事（90% 的失败都出在这）

### ① 平台必须匹配：Linux 服务器不能用 .exe

Debian 服务器需要 **Linux x64 的 ELF 二进制**。在 Windows 上编译/下载到的是 `.exe`（PE 格式），
**放到 Linux 上完全跑不了**。

判断方法（在服务器上）：

```bash
file whisper/whisper-cli
# 正确：ELF 64-bit LSB executable, x86-64 ...
# 错误：PE32+ executable (console) ...（这是 Windows 的 exe）
```

### ② 动态链接的库必须一起拷

新版 whisper-cli 是动态链接的，运行时要同目录下的共享库：

```
libwhisper.so.1        ← 最关键，缺它报 "cannot open shared object file"
libggml.so.0
libggml-base.so.0
libggml-cpu-*.so       ← 十几个 CPU 分派库（haswell/sandybridge/zen4...）
```

**只拷 `whisper-cli` 一个文件必炸**，报错长这样：

```
whisper-cli: error while loading shared libraries: libwhisper.so.1:
cannot open shared object file: No such file or directory
```

**规则：把解压目录里的所有文件全部传过去，一个都不要挑。**

---

## 1. 在能上网的电脑上下载 whisper-cli（三选一）

### 方法 A：下载官方预编译包（最简单，推荐）

打开 [whisper.cpp Releases 页](https://github.com/ggml-org/whisper.cpp/releases)，
下载名字包含 **`ubuntu-x64` 或 `linux-x64`**、后缀 **`.zip`** 的资产。也可用命令：

```bash
# Linux / macOS / WSL 上：
wget https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-cpp-v1.7.6-ubuntu-x64.zip
unzip whisper-cpp-v1.7.6-ubuntu-x64.zip -d whisper-linux
```

```powershell
# Windows PowerShell 上：
cd $HOME\Downloads
Invoke-WebRequest -Uri "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-cpp-v1.7.6-ubuntu-x64.zip" -OutFile whisper-linux.zip
Expand-Archive whisper-linux.zip -DestinationPath whisper-linux
```

> ⚠️ **注意 404**：whisper.cpp 后来改用构建号 tag（如 `b4938`），资产命名会变。
> 上面 v1.7.6 链接若 404，就打开 Releases 页手动找最新一个名字含
> `ubuntu-x64` / `linux-x64` 的 `.zip`（`.tar.gz` 也行，内容一样）。
>
> 解压后检查目录：应看到 **`whisper-cli`（没有 .exe 后缀）** 和一堆 `lib*.so*`。

### 方法 B：源码编译（Linux/WSL 上，永远可用、最可靠）

```bash
# Debian/Ubuntu 先装依赖
sudo apt install -y git cmake build-essential

git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF   # 静态编译，单文件最省心
cmake --build build --config Release -j
```

产物：`build/bin/whisper-cli`（静态链接版，**只需传这一个文件**，没有 .so 依赖问题）。
确认一下：

```bash
ldd build/bin/whisper-cli   # 静态版输出 "not a dynamic executable" 或只有系统库
```

### 方法 C：Windows 装了 WSL 的话，直接跑官方脚本

```bash
# Windows PowerShell 里输入 wsl 进入 Linux 环境
wsl
cd <仓库路径>/server
bash setup-whisper.sh       # 自动下载 Linux 包并连 .so 一起拷好
```

---

## 2. 下载模型 ggml-base.bin（约 75MB）

```bash
# 官方地址（国外网络）：
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# 国内镜像（hf-mirror.com，推荐国内服务器用）：
wget https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

```powershell
# Windows PowerShell：
Invoke-WebRequest -Uri "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" -OutFile ggml-base.bin
```

> 想转写更准可以换 **`ggml-small.bin`**（约 466MB，中文识别明显更好），
> 下载方式同上，文件名保持 `ggml-small.bin`，之后改 config.yaml 的 model 路径即可。

### 2.5 本地 Vosk 引擎（可选，离线免费）

不想用 whisper 也可以装 **Vosk**（本地离线识别，CPU 占用低、响应快）。需要两样东西：

1. **vosk 模块**（平台相关原生模块，**必须在 Linux x64 环境安装**，Windows 上装的不能用）：
   - 服务器能访问 npm：`cd /home/screen-connect/server && npm install vosk --no-save`
   - 服务器没网：在有网的 **Linux/WSL** 里对 server 目录执行同样的命令，然后把 `node_modules/vosk` 整个目录传到服务器
2. **模型**（解压到 `server/` 下，目录名对应 config 里 `vosk.modelDir`）：
   ```bash
   # 小模型（中文，约 42MB，推荐先试这个）
   wget https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
   unzip vosk-model-small-cn-0.22.zip -d /home/screen-connect/server/
   # 大模型（中文，约 1.4GB，更准）
   # wget https://alphacephei.com/vosk/models/vosk-model-cn-0.22.zip
   ```
3. config.yaml 里 `mode: "local-vosk"`（转写引擎由服务器 config 统一决定），并确认 `vosk.modelDir` 与解压目录一致。

---

## 3. 传到服务器并摆放

服务器上创建目录：

```bash
mkdir -p /home/screen-connect/server/whisper
```

从能上网的电脑传**整个解压目录**（最稳，绝不漏文件）+ 模型：

```bash
# 在解压目录 whisper-linux 的上一级执行
scp -r whisper-linux/* root@<服务器IP>:/home/screen-connect/server/whisper/
scp ggml-base.bin root@<服务器IP>:/home/screen-connect/server/whisper/
```

> 没有 scp 的话：把整个 `whisper-linux` 目录压缩成 zip，传到服务器再解压：
>
> ```bash
> cd /home/screen-connect/server/whisper
> unzip -o 你上传的.zip -d .
> ```

最终目录应该长这样：

```
server/whisper/
├── whisper-cli
├── libwhisper.so.1
├── libggml.so.0
├── libggml-base.so.0
├── libggml-cpu-*.so          # 十几个 CPU 分派库，都要有
└── ggml-base.bin
```

---

## 4. 服务器上验证（三连）

```bash
cd /home/screen-connect/server/whisper

# ① 执行权限
chmod +x whisper-cli

# ② 依赖检查：所有行必须显示 found，出现 "not found" 就是漏文件了
ldd ./whisper-cli

# ③ 模型加载测试：看到 whisper_model_load ... ok 即正常
./whisper-cli -m ggml-base.bin -nt -f /tmp/任意.wav 2>&1 | head -8
```

`ldd` 有 `not found` → 回第 1 步的解压目录找对应文件补传。

---

## 5. 启动服务器 + 测试

```bash
cd /home/screen-connect/server
node server.js
```

启动日志应显示 `[asr] ASR 就绪`。

客户端（浏览器打开服务器地址，或桌面端）→ 进房间 → 点底部 **📝 转写** → 对着麦克风说话：

- 服务器日志出现转写文本 = 成功
- `server/logs/` 生成 `房间-开始-结束.txt`

> 服务器代码（asr.js）调用 whisper 时会自动把 `whisper/` 目录加进 `LD_LIBRARY_PATH`，
> 所以只要 .so 和 whisper-cli 在同一个目录，直接 `node server.js` 即可，无需手动 export。

---

## 6. 常见错误对照表

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `curl: (22) The requested URL returned an error: 404` | whisper.cpp 换了 tag / 资产命名 | 打开 Releases 页手动找 `ubuntu-x64`/`linux-x64` 的 zip；或源码编译 |
| `libwhisper.so.1: cannot open shared object file` | 只拷了 whisper-cli，没带 .so | 解压目录**所有文件**全传过去；`ldd` 验证 |
| 传过去的是 `.exe`，Linux 跑不了 | 下载/编译了 Windows 版 | 用官方 ubuntu-x64 包（无 .exe 后缀），或开 WSL 编译 |
| HuggingFace 下载失败/超时 | 网络不通 | 用 `hf-mirror.com` 镜像，或从 GitHub release 资产下载 |
| `[asr] whisper 调用失败`，stderr 是别的错误 | whisper 本身的问题 | 把服务器日志整段发出来排查 |
| 转写不出字 | VAD 阈值太高 / 麦克风太远 | config.yaml 里 `vadThreshold: 0.012` → `0.008`；贴近麦克风、语速放慢 |
| 中文识别差 | base 模型能力有限 | 换 `ggml-small.bin`（466MB） |

---

## 7. 最后确认 config.yaml

```yaml
asr:
  enabled: true                  # 必须 true
  mode: "local-whisper"            # 转写引擎由服务器决定：local-vosk | local-whisper | aliyun-bailian
  logDir: "logs"
  whisper:
    bin: "whisper/whisper-cli"
    model: "whisper/ggml-base.bin" # 换 small 就写 whisper/ggml-small.bin
    language: "zh"                 # 中文
    threads: 4
  vosk:
    modelDir: "vosk-model-small-cn-0.22"
  aliyun:
    apiKey: ""
    workspaceId: ""
```
