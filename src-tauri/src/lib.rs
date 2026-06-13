//! Leo work — Tauri 桌面外殼。
//!
//! 重運算（加密 / 向量庫 / Claude）都在 Node sidecar，前端以 HTTP 呼叫。
//! 開發模式由 `npm run dev`（concurrently）同時啟動 vite 與 sidecar；
//! 正式版請參考 README 將 sidecar 打包為 externalBin 後於此 spawn。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("執行 Tauri 應用程式時發生錯誤");
}
