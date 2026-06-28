// 自動更新（只在 Tauri 桌面殼內可用；瀏覽器 dev 直接 no-op）。
// 連 GitHub Releases 的 latest.json（見 src-tauri/tauri.conf.json 的 plugins.updater）。
import type { Update } from "@tauri-apps/plugin-updater";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 是否為桌面 App（Tauri 殼）；網頁版/dev 為 false，無法自動更新。 */
export function isDesktopApp(): boolean {
  return inTauri();
}

/**
 * 更新安裝前殺掉所有 leo-node sidecar（含本 App 沒管理到的孤兒殘留），釋放 lancedb .node 檔鎖，
 * 避免 NSIS OTA「Error opening file for writing」。比 shutdownSidecar（只關當前那隻）更徹底。
 * 非 Tauri 環境 no-op；失敗只記錄不阻斷更新。
 */
export async function killSidecars(): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("kill_sidecars");
  } catch (e) {
    console.warn("殺殘留 sidecar 失敗", e);
  }
}

/** 檢查是否有新版；無更新或非 Tauri 環境回 null。 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!inTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    return await check();
  } catch (e) {
    console.warn("更新檢查失敗", e);
    return null;
  }
}

/** 下載並安裝更新，完成後重啟 App。 */
export async function installUpdateAndRelaunch(
  update: Update,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.(downloaded, total);
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** 重啟 App（Tauri 殼內真重啟；瀏覽器 dev 退回 reload）。 */
export async function relaunchApp(): Promise<void> {
  if (!inTauri()) {
    window.location.reload();
    return;
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
