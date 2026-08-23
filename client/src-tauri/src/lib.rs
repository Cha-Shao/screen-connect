// ScreenConnect 桌面端 Rust 后端
// 主要职责：生成机器码（跨平台，取操作系统级唯一标识并归一化为 4-4-4-4 格式）
//           + ASR 转写日志「另存为」原生对话框（Windows GetSaveFileNameW）

#[tauri::command]
fn get_machine_id() -> String {
    let raw = machine_guid();
    let clean: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_uppercase();
    let hex = if clean.len() >= 16 { &clean[..16] } else { clean.as_str() };
    let mut out = String::new();
    for (i, c) in hex.chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        out.push(c);
    }
    if out.is_empty() {
        out.push_str("0000-0000-0000-0000");
    }
    out
}

/// 取操作系统级机器唯一标识
/// Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
/// macOS:   IOPlatformUUID
/// Linux:   /etc/machine-id
fn machine_guid() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(o) = std::process::Command::new("reg")
            .args(["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
            .output()
        {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if let Some(idx) = line.find("REG_SZ") {
                    let v = line[idx + 6..].trim();
                    if !v.is_empty() {
                        return v.to_string();
                    }
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(o) = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if line.contains("IOPlatformUUID") {
                    if let Some(idx) = line.find('=') {
                        let v = line[idx + 1..].trim().trim_matches('"');
                        if !v.is_empty() {
                            return v.to_string();
                        }
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(s) = std::fs::read_to_string(p) {
                let v = s.trim();
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    // 兜底：用主机名
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

/// 保存 ASR 转写日志：弹出系统「另存为」对话框让用户选择保存位置。
/// 返回保存后的完整路径；用户取消对话框时返回 null。
#[tauri::command]
async fn save_asr_log(
    app: tauri::AppHandle,
    content: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    // 取主窗口句柄作为对话框所有者，让「另存为」窗口模态置前
    // （用 usize 传递，raw pointer 不是 Send，无法进 spawn_blocking）
    #[cfg(target_os = "windows")]
    let owner: usize = {
        use tauri::Manager;
        app.get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as usize)
            .unwrap_or(0)
    };
    #[cfg(not(target_os = "windows"))]
    let owner: usize = 0;

    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        // 在独立线程弹出原生保存对话框，避免阻塞 WebView 事件循环
        let owner = owner as *mut core::ffi::c_void;
        let Some(path) = pick_save_path(&suggested_name, owner)? else {
            return Ok(None); // 用户点了取消
        };
        // 写 UTF-8（带 BOM，兼容旧版记事本等程序）
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(content.as_bytes());
        std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {}", e))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("保存线程异常: {}", e))?
}

/// 弹出系统「另存为」对话框，返回用户选择的路径；取消返回 Ok(None)。
/// Windows 用原生 GetSaveFileNameW 通用对话框。
#[cfg(target_os = "windows")]
fn pick_save_path(
    suggested_name: &str,
    owner: *mut core::ffi::c_void,
) -> Result<Option<std::path::PathBuf>, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetSaveFileNameW, OPENFILENAMEW, OFN_ENABLESIZING, OFN_EXPLORER, OFN_HIDEREADONLY,
        OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST,
    };

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    // 文件名字符串缓冲区（GetSaveFileNameW 支持最长 32767 字符的完整路径）
    let mut file_buf = vec![0u16; 32768];
    let suggested: Vec<u16> = wide(suggested_name);
    let n = suggested.len().min(file_buf.len());
    file_buf[..n].copy_from_slice(&suggested[..n]);

    let filter = wide("文本文件 (*.txt)\0*.txt\0所有文件 (*.*)\0*.*\0\0");
    let title = wide("保存转写日志");
    let def_ext = wide("txt");

    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: owner,
        hInstance: std::ptr::null_mut(),
        lpstrFilter: filter.as_ptr(),
        lpstrCustomFilter: std::ptr::null_mut(),
        nMaxCustFilter: 0,
        nFilterIndex: 1,
        lpstrFile: file_buf.as_mut_ptr(),
        nMaxFile: file_buf.len() as u32,
        lpstrFileTitle: std::ptr::null_mut(),
        nMaxFileTitle: 0,
        lpstrInitialDir: std::ptr::null(),
        lpstrTitle: title.as_ptr(),
        Flags: OFN_OVERWRITEPROMPT
            | OFN_PATHMUSTEXIST
            | OFN_HIDEREADONLY
            | OFN_EXPLORER
            | OFN_ENABLESIZING
            | OFN_NOCHANGEDIR,
        nFileOffset: 0,
        nFileExtension: 0,
        lpstrDefExt: def_ext.as_ptr(),
        lCustData: 0,
        lpfnHook: None,
        lpTemplateName: std::ptr::null(),
        pvReserved: std::ptr::null_mut(),
        dwReserved: 0,
        FlagsEx: 0,
    };

    // 阻塞直到用户确认或取消
    let ok = unsafe { GetSaveFileNameW(&mut ofn) };
    if ok == 0 {
        return Ok(None); // 用户取消
    }
    let len = file_buf
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(file_buf.len());
    let path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&file_buf[..len]));
    Ok(Some(path))
}

/// 非 Windows 平台暂不弹原生对话框：返回错误，前端回退到浏览器下载。
#[cfg(not(target_os = "windows"))]
fn pick_save_path(
    _suggested_name: &str,
    _owner: *mut core::ffi::c_void,
) -> Result<Option<std::path::PathBuf>, String> {
    Err("当前平台不支持原生保存对话框".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_machine_id, save_asr_log])
        .run(tauri::generate_context!())
        .expect("启动 ScreenConnect 失败");
}
