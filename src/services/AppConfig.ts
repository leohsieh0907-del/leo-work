// ════════════════════════════════════════════════════════════════════
//  AppConfig — 正式版執行期設定（取代 .env）
//
//  dev：靠 `.env`（dotenv 已先載入），本模組不動既有行為。
//  正式版：安裝檔沒有 .env → 改從「app 資料夾」的 config.json 讀設定，並把值
//          灌進 process.env（**只填補 process.env 尚未有的鍵**，所以 dev 的
//          .env 永遠優先），讓 server.ts 既有的 process.env.X 讀法零改動沿用。
//
//  資料夾：由 Tauri 啟動 sidecar 時用 LEO_DATA_DIR 帶入 app_data_dir；
//          dev 未設則退回 ./data（與原本相同）。
//
//  ⚠️ ENCRYPTION_SALT 是本機加密的「主密鑰」（單機個人用、免密碼）：
//     首次啟動產生一次後**永不覆蓋**——蓋掉＝既有加密會議全部解不開。
//     設定檔損壞時**拒絕續行**（寧可報錯，也不重生 salt 而毀掉舊資料）。
// ════════════════════════════════════════════════════════════════════

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

/** config.json 內容：encryptionSalt + 一組可選的 env 鍵（GEMINI_API_KEY 等）。 */
export interface RuntimeConfigFile {
  encryptionSalt?: string;
  [envKey: string]: string | undefined;
}

/** 設定/資料夾：LEO_DATA_DIR（Tauri 帶入）優先，dev 退回 ./data。 */
export function getDataDir(): string {
  const d = process.env.LEO_DATA_DIR;
  return d && d.length > 0 ? path.resolve(d) : path.resolve("data");
}

export function getConfigPath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, "config.json");
}

function readConfigFile(configPath: string): RuntimeConfigFile {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as RuntimeConfigFile;
    throw new Error("not an object");
  } catch {
    // 損壞就報錯停止：絕不在「讀不到舊 salt」的狀態下重生 salt 而毀掉既有加密資料。
    throw new Error(`設定檔損壞，拒絕覆蓋以免遺失加密金鑰：${configPath}`);
  }
}

function writeConfigFileAtomic(configPath: string, cfg: RuntimeConfigFile): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  renameSync(tmp, configPath); // 原子置換，避免寫一半損壞
}

/**
 * 載入正式版執行期設定並灌進 process.env（在讀任何設定前呼叫一次）。
 * - ENCRYPTION_SALT：env > 設定檔 > 首次產生（產生後寫回設定檔，永不覆蓋既有）。
 * - 其餘鍵：僅在 process.env 尚未有值時，由設定檔填補（.env / Tauri 注入優先）。
 */
export function loadRuntimeConfig(): { dataDir: string; configPath: string } {
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });
  const configPath = getConfigPath(dataDir);
  const cfg = readConfigFile(configPath);

  let dirty = false;

  // ENCRYPTION_SALT：主密鑰，缺了才產生且只產生一次
  if (!process.env.ENCRYPTION_SALT) {
    if (!cfg.encryptionSalt) {
      cfg.encryptionSalt = randomBytes(32).toString("hex"); // 256-bit
      dirty = true;
    }
    process.env.ENCRYPTION_SALT = cfg.encryptionSalt;
  }

  // 其餘設定檔鍵 → 只填補空缺（不覆蓋 .env / Tauri 帶入的值）
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "encryptionSalt") continue;
    if (typeof v === "string" && v.length > 0 && !process.env[k]) {
      process.env[k] = v;
    }
  }

  if (dirty) writeConfigFileAtomic(configPath, cfg);
  return { dataDir, configPath };
}

/** 給設定畫面用：更新設定檔的指定鍵（合併寫入，保留既有 encryptionSalt）。 */
export function updateRuntimeConfig(patch: RuntimeConfigFile): void {
  const configPath = getConfigPath();
  const cfg = readConfigFile(configPath);
  for (const [k, v] of Object.entries(patch)) {
    if (k === "encryptionSalt") continue; // 主密鑰禁止從外部改
    if (v === undefined || v === "") delete cfg[k];
    else cfg[k] = v;
  }
  writeConfigFileAtomic(configPath, cfg);
}

/** 給設定畫面用：回報非機密的設定狀態（不外洩金鑰值）。 */
export function getRuntimeConfigStatus(): { hasGeminiKey: boolean; llmProvider: string } {
  return {
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    llmProvider: process.env.LLM_PROVIDER ?? "ollama",
  };
}
