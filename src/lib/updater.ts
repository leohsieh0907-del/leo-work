// 自動更新（只在 Tauri 桌面殼內可用；瀏覽器 dev 直接 no-op）。
// 連 GitHub Releases 的 latest.json（見 src-tauri/tauri.conf.json 的 plugins.updater）。
import type { Update } from "@tauri-apps/plugin-updater";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
