// ScreenConnect 桌面端 Rust 后端
// 主要职责：生成机器码（跨平台，取操作系统级唯一标识并归一化为 4-4-4-4 格式）

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_machine_id])
        .run(tauri::generate_context!())
        .expect("启动 ScreenConnect 失败");
}
