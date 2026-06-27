// ════════════════════════════════════════════════════════════════════
//  MeetingStore — 會議存檔（AES-256-GCM 加密落地）
//
//  每場會議（逐字稿 + 分析 + 行動方針）以加密 JSON 存成 data/meetings/<id>.enc，
//  另有一份加密索引 _index.enc 存中繼資料供歷史列表。金鑰走 server 端
//  ENCRYPTION_SALT（單機個人用，免密碼提示）；防拷：沒有 .env 的 salt 就解不開。
// ════════════════════════════════════════════════════════════════════

import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import { SecurityManager } from "./SecurityManager";
import { AppError, ErrorCode, type SavedMeeting, type MeetingListItem } from "../shared/types";

export class MeetingStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(
    private readonly security: SecurityManager,
    private readonly secretKey: string,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, "meetings");
    this.indexPath = path.join(this.dir, "_index.enc");
  }

  /** 用 id 的 sha1 當檔名，避免中文/特殊字清洗後撞檔互蓋（真實 id 存在索引與內容裡）。 */
  private meetingPath(id: string): string {
    const h = createHash("sha1").update(id, "utf8").digest("hex").slice(0, 16);
    return path.join(this.dir, `${h}.enc`);
  }

  /** 歷史列表（解密索引；尚無任何會議時回空陣列）。 */
  async list(): Promise<MeetingListItem[]> {
    try {
      const buf = await this.security.decryptFromFile(this.indexPath, this.secretKey);
      const items = JSON.parse(buf.toString("utf8")) as MeetingListItem[];
      return Array.isArray(items) ? items : [];
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.CRYPTO_FILE_CORRUPT) return [];
      throw e;
    }
  }

  private async writeIndex(items: MeetingListItem[]): Promise<void> {
    await this.security.encryptToFile(
      this.indexPath,
      Buffer.from(JSON.stringify(items), "utf8"),
      this.secretKey,
    );
  }

  /** 存檔（同 id 視為更新）。 */
  async save(meeting: SavedMeeting): Promise<MeetingListItem> {
    if (!meeting?.id) throw new AppError(ErrorCode.INVALID_INPUT, "會議缺少 id");
    await this.security.encryptToFile(
      this.meetingPath(meeting.id),
      Buffer.from(JSON.stringify(meeting), "utf8"),
      this.secretKey,
    );
    const item: MeetingListItem = {
      id: meeting.id,
      title: meeting.title,
      date: meeting.date,
      savedAt: meeting.savedAt,
    };
    const items = await this.list();
    const idx = items.findIndex((m) => m.id === meeting.id);
    if (idx >= 0) items[idx] = item;
    else items.unshift(item);
    // 依存檔時間新到舊排序
    items.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    await this.writeIndex(items);
    return item;
  }

  /** 改名（只改顯示用 title，id/檔名不動 → 不影響跨會議記憶、不產生重複檔）。 */
  async rename(id: string, title: string): Promise<MeetingListItem> {
    const t = title.trim();
    if (!t) throw new AppError(ErrorCode.INVALID_INPUT, "新名稱不可為空");
    const meeting = await this.load(id); // 找不到會丟錯
    meeting.title = t;
    await this.security.encryptToFile(
      this.meetingPath(id),
      Buffer.from(JSON.stringify(meeting), "utf8"),
      this.secretKey,
    );
    const items = await this.list();
    const idx = items.findIndex((m) => m.id === id);
    const item: MeetingListItem = { id, title: t, date: meeting.date, savedAt: meeting.savedAt };
    if (idx >= 0) items[idx] = { ...items[idx], title: t };
    else items.unshift(item);
    await this.writeIndex(items);
    return idx >= 0 ? items[idx] : item;
  }

  /** 讀回一場會議（解密）。 */
  async load(id: string): Promise<SavedMeeting> {
    const buf = await this.security.decryptFromFile(this.meetingPath(id), this.secretKey);
    return JSON.parse(buf.toString("utf8")) as SavedMeeting;
  }

  /** 刪除一場會議（連索引）。 */
  async remove(id: string): Promise<void> {
    try {
      await fs.unlink(this.meetingPath(id));
    } catch {
      /* 檔案不存在也無妨 */
    }
    const items = (await this.list()).filter((m) => m.id !== id);
    await this.writeIndex(items);
  }
}
