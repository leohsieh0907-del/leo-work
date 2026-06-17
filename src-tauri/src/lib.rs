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
    use tauri_plugin_shell::ShellExt;

    let server = app
        .path()
        .resolve("sidecar/server.cjs", tauri::path::BaseDirectory::Resource)?;

    let _child = app
        .shell()
        .sidecar("leo-node")?
        .arg(server.to_string_lossy().to_string())
        .env("SIDECAR_PORT", "8765")
        .spawn()?;

    Ok(())
}
