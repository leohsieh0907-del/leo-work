//! Leo work — Tauri 桌面外殼。
//!
//! 重運算（加密 / 向量庫 / Claude）都在 Node sidecar，前端以 HTTP 呼叫。
//! - 開發模式：由 `npm run dev`（concurrently）同時啟動 vite 與 sidecar，這裡不 spawn。
//! - 正式版：sidecar 以 `assemble:sidecar` 打包成 resources(`sidecar/`) + Node runtime
//!   externalBin(`binaries/leo-node`)，於 setup 階段 spawn（見 `spawn_sidecar`）。
//!
//! App 結束時會 kill 掉 spawn 的 sidecar（`RunEvent::Exit`，正常關閉路徑），避免 8765 殘留／
//! 舊 sidecar 續跑舊碼／裝新版時 lancedb 檔被鎖。（force-kill 不經 Exit，屬另案。）
//! 另：更新安裝前前端會 invoke `kill_sidecars` 強殺所有 leo-node（含 Exit 沒收到的孤兒殘留），
//! 徹底釋放檔鎖再讓 NSIS 覆寫，根治 OTA「Error opening file for writing」。
//! 正式版執行期密鑰（ENCRYPTION_SALT / GEMINI_API_KEY / GROQ_API_KEY）由 app 設定檔 config.json
//! 注入（AppConfig，非 .env）；這裡只帶 SIDECAR_PORT 與 LEO_DATA_DIR。

/// 持有 spawn 出的 sidecar `Child`，供 App 結束時 kill（只在正式版存在）。
#[cfg(not(debug_assertions))]
struct SidecarGuard(std::sync::Mutex<Option<std::process::Child>>);

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
        .invoke_handler(tauri::generate_handler![kill_sidecars])
        .setup(|_app| {
            // 正式版才 spawn 打包的 sidecar；dev 由 npm run dev 啟動。
            #[cfg(not(debug_assertions))]
            {
                use tauri::Manager;
                let child = spawn_sidecar(_app)?;
                // 存著 Child handle，App 結束時 kill（見下方 RunEvent::Exit）。
                _app.manage(SidecarGuard(std::sync::Mutex::new(Some(child))));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("執行 Tauri 應用程式時發生錯誤")
        .run(|_app_handle, _event| {
            // App 真正結束時，收掉 spawn 的 sidecar（正常關閉路徑）。
            #[cfg(not(debug_assertions))]
            if let tauri::RunEvent::Exit = _event {
                use tauri::Manager;
                if let Some(guard) = _app_handle.try_state::<SidecarGuard>() {
                    if let Ok(mut lock) = guard.0.lock() {
                        if let Some(mut child) = lock.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}

/// 更新安裝前由前端呼叫：強制殺掉所有 leo-node sidecar 行程（含本 App 沒管理到的「孤兒」殘留），
/// 釋放 lancedb `.node` 等檔鎖，避免 NSIS OTA 出現「Error opening file for writing」。
/// 只在 Windows 有作用（mac/Linux 更新不走 NSIS、無此檔鎖問題）；沒有行程可殺也無妨（忽略結果）。
#[tauri::command]
fn kill_sidecars() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // 別彈出 console 視窗
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/IM", "leo-node.exe"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

/// 啟動打包進 resources 的 Node sidecar（leo-node externalBin + sidecar/server.cjs）。
#[cfg(not(debug_assertions))]
fn spawn_sidecar(app: &tauri::App) -> Result<std::process::Child, Box<dyn std::error::Error>> {
    use tauri::Manager;

    let exe = std::env::current_exe()?;
    let exe_dir = exe.parent().ok_or("無法取得執行檔目錄")?;

    // server.cjs 落點因平台/打包方式而異 → 依序找第一個存在的，找不到就明確報錯。
    // ⚠️ exe_dir-based（乾淨絕對路徑）放最前；app.path().resolve(Resource) 在 Windows 會回傳
    // \\?\ verbatim 路徑（Node 解析會爆，見下「關鍵根因 2」），放最後當保底。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    candidates.push(exe_dir.join("sidecar").join("server.cjs"));
    candidates.push(exe_dir.join("resources").join("sidecar").join("server.cjs"));
    if let Ok(p) = app
        .path()
        .resolve("sidecar/server.cjs", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
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

    // ⚠️ 關鍵根因 2（實測定論）：Node 只要拿到 \\?\ 擴充長度路徑（不論在主程式參數或 CWD），
    // resolveMainPath 都會誤判成 'C:'（EISDIR）→ sidecar 起不來；唯有「乾淨路徑」能起。打包版
    // app.path().resolve(Resource) 與某些 current_exe 會是 \\?\ verbatim。對策（雙保險）：
    //   ① candidate 乾淨路徑優先（見上）；② CWD 設為 sidecar 目錄並去掉 \\?\ 前綴，主程式只傳
    //      「相對檔名 server.cjs」→ 沒有磁碟機代號/空格/verbatim，Node 必能解析。
    // CWD 不影響資料路徑（server.ts 走 LEO_DATA_DIR env，已於上方帶入）。
    let server_dir = server.parent().ok_or("無法取得 sidecar 目錄")?;
    let server_dir_str = server_dir.to_string_lossy();
    let server_dir_clean: &str = server_dir_str.strip_prefix(r"\\?\").unwrap_or(&server_dir_str);

    let child = std::process::Command::new(&node)
        .current_dir(server_dir_clean)
        .arg("server.cjs")
        .env("SIDECAR_PORT", "8765")
        .env("LEO_DATA_DIR", &data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err))
        .spawn()?;

    Ok(child)
}
