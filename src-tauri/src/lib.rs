//! Leo work — Tauri 桌面外殼。
//!
//! 重運算（加密 / 向量庫 / Claude）都在 Node sidecar，前端以 HTTP 呼叫。
//! - 開發模式：由 `npm run dev`（concurrently）同時啟動 vite 與 sidecar，這裡不 spawn。
//! - 正式版：sidecar 以 `assemble:sidecar` 打包成 resources(`sidecar/`) + Node runtime
//!   externalBin(`binaries/leo-node`)，於 setup 階段 spawn（見 `spawn_sidecar`）。
//!
//! ⚠️ 尚待 CI 迭代收尾（里程碑 2/3）：
//!   - 結束時關閉 sidecar（否則 127.0.0.1:8765 殘留，下次啟動綁不到）。
//!   - 正式版執行期密鑰（ENCRYPTION_SALT / GEMINI_API_KEY）來源——不能靠 .env，
//!     需改由 app 設定檔 / 首次啟動設定畫面注入（這裡先只帶 SIDECAR_PORT）。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|_app| {
            // 正式版才 spawn 打包的 sidecar；dev 由 npm run dev 啟動。
            #[cfg(not(debug_assertions))]
            spawn_sidecar(_app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("執行 Tauri 應用程式時發生錯誤");
}

/// 啟動打包進 resources 的 Node sidecar（leo-node externalBin + sidecar/server.cjs）。
#[cfg(not(debug_assertions))]
fn spawn_sidecar(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;

    let exe = std::env::current_exe()?;
    let exe_dir = exe.parent().ok_or("無法取得執行檔目錄")?;

    // server.cjs 落點因平台/打包方式而異 → 依序找第一個存在的，找不到就明確報錯。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve("sidecar/server.cjs", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    candidates.push(exe_dir.join("sidecar").join("server.cjs"));
    candidates.push(exe_dir.join("resources").join("sidecar").join("server.cjs"));
    let server = candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or("找不到 sidecar/server.cjs（打包資源缺失）")?;

    // Node runtime（externalBin，打包後在 exe 旁）
    let node = exe_dir.join(format!("leo-node{}", std::env::consts::EXE_SUFFIX));
    // 加密金鑰/設定/向量庫都放這（每位使用者固定、更新後保留）
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    // ⚠️ 關鍵根因：GUI 外殼(windows_subsystem=windows)沒有 console，子行程繼承到「無效 stdio
    // handle」；node 在 init 期間 console.log 寫到壞掉的 stdout → 卡住/出錯 → sidecar 起不來
    // (實測：重導 stdio 到檔案的手動跑法正常，直接繼承就掛)。把 sidecar 的 stdout/stderr 導到
    // log 檔(有效 handle)，順便留下啟動錯誤紀錄。
    let log = std::fs::File::create(data_dir.join("sidecar.log"))?;
    let log_err = log.try_clone()?;

    // ⚠️ 關鍵根因 2：Tauri 在 Windows 的 Resource resolve 會回傳 \\?\ 擴充長度路徑；Node 的
    // 模組解析器(resolveMainPath)會把它誤判成 'C:'（EISDIR）→ sidecar 永遠起不來。純路徑手動
    // 跑正常、打包版必爆。傳給 Node 當主程式前去掉 \\?\ 前綴（非 verbatim 路徑則原樣不動）。
    let server_str = server.to_string_lossy();
    let server_arg: &str = server_str.strip_prefix(r"\\?\").unwrap_or(&server_str);

    std::process::Command::new(&node)
        .arg(server_arg)
        .env("SIDECAR_PORT", "8765")
        .env("LEO_DATA_DIR", &data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err))
        .spawn()?;

    Ok(())
}
