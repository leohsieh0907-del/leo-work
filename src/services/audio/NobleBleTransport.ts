// ════════════════════════════════════════════════════════════════════
//  NobleBleTransport — 以 @abandonware/noble 實作 BleTransport（Windows BLE）
//
//  ⚠️ 環境硬事實：
//   • noble 是「原生套件」，Windows 上安裝可能失敗（需 build 工具）；它也「沒有
//     型別宣告」。故本檔【頂層絕不 import noble】——改在 connect() 內用動態
//     import 載入；noble 缺席（未安裝 / 此平台不支援 BLE）時拋明確的繁中
//     AppError(IO_ERROR)，絕不讓 typecheck 或 install 失敗。
//   • noble 用 `as any` 包，因為它無型別。所有對 noble 物件的存取都集中在本檔，
//     上層只認 BleTransport 介面，完全不沾 noble。
//
//  ⚠️ PM01-9 私有協定整合點：
//   服務 UUID / notify 特徵（裝置→PC）/ write 特徵（PC→裝置）由建構參數帶入；
//   實際的 GATT UUID 為 PM01-9 裝置私有協定，需【原廠文件】填入（呼叫端從設定
//   檔 / env 提供）。本檔只負責把 noble 的 notify/write 接到 BleTransport.onData /
//   send；上面跑的是 ResumableTransfer 的自定 framing，與裝置協定解耦。
// ════════════════════════════════════════════════════════════════════

import { AppError, ErrorCode } from "../../shared/types";
import type { BleTransport } from "./types";

export interface NobleBleTransportOptions {
  /** 要掃描 / 連線的 GATT 服務 UUID（PM01-9 私有，需原廠文件）。 */
  serviceUuid: string;
  /** notify 特徵 UUID：裝置→PC 推送位元組（GATT notify）。 */
  notifyUuid: string;
  /** write 特徵 UUID：PC→裝置 下指令（RESUME / ACK）。 */
  writeUuid: string;
  /** 掃描逾時毫秒，預設 20000（找不到裝置即放棄）。 */
  scanTimeoutMs?: number;
}

/** noble 無型別，集中以此別名標注「動態載入、形狀未知」的物件。 */
type AnyNoble = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyPeripheral = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyCharacteristic = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 把可能帶連字號 / 大小寫不一的 UUID 正規化成 noble 慣用的小寫無連字號形式。 */
function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

export class NobleBleTransport implements BleTransport {
  private readonly serviceUuid: string;
  private readonly notifyUuid: string;
  private readonly writeUuid: string;
  private readonly scanTimeoutMs: number;

  /** 動態載入後的 noble 單例（缺席時為 undefined）。 */
  private noble?: AnyNoble;
  private peripheral?: AnyPeripheral;
  private notifyChar?: AnyCharacteristic;
  private writeChar?: AnyCharacteristic;

  /** 上層註冊的 onData 回呼（notify→這裡）。 */
  private dataCb?: (data: Uint8Array) => void;
  /** notify 監聽器參考，disconnect 時移除避免洩漏。 */
  private notifyHandler?: (data: Buffer, isNotification: boolean) => void;

  private _connected = false;

  constructor(opts: NobleBleTransportOptions) {
    if (!opts || !opts.serviceUuid || !opts.notifyUuid || !opts.writeUuid) {
      throw new AppError(
        ErrorCode.CONFIG_MISSING,
        "NobleBleTransport 需要 serviceUuid / notifyUuid / writeUuid（PM01-9 私有協定，需原廠文件）",
      );
    }
    this.serviceUuid = normalizeUuid(opts.serviceUuid);
    this.notifyUuid = normalizeUuid(opts.notifyUuid);
    this.writeUuid = normalizeUuid(opts.writeUuid);
    this.scanTimeoutMs = opts.scanTimeoutMs && opts.scanTimeoutMs > 0 ? opts.scanTimeoutMs : 20_000;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** 訂閱裝置推送的位元組（GATT notify）。在 connect 之前或之後呼叫皆可。 */
  onData(callback: (data: Uint8Array) => void): void {
    this.dataCb = callback;
  }

  /**
   * 掃描指定 serviceUuid 的裝置 → 連線 → 取得 notify / write 特徵 → 訂閱 notify。
   * noble 缺席時拋 AppError(IO_ERROR,"未安裝 noble 或此平台不支援 BLE")。
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    const noble = await this.loadNoble();
    this.noble = noble;

    // 1) 等 BLE 介面卡就緒（poweredOn），逾時即視為此平台不支援 / 卡硬體問題。
    await this.waitPoweredOn(noble);

    // 2) 掃描目標服務 → 連線 → 找特徵。失敗一律停掃並拋結構化錯誤。
    const peripheral = await this.scanForPeripheral(noble);
    this.peripheral = peripheral;

    try {
      await this.promisify((cb) => peripheral.connect(cb));
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        "BLE 連線失敗",
        err instanceof Error ? err.message : err,
      );
    }

    await this.discoverCharacteristics(peripheral);

    // 3) 訂閱 notify：noble 的 characteristic 以 'data' 事件推 Buffer。
    this.notifyHandler = (data: Buffer) => {
      // 轉成 Uint8Array 交給上層（ResumableTransfer 解析 framing）。
      this.dataCb?.(new Uint8Array(data));
    };
    this.notifyChar!.on("data", this.notifyHandler);
    await this.promisify((cb) => this.notifyChar!.subscribe(cb));

    // 4) 裝置主動斷線時更新狀態，讓 ResumableTransfer 的重連監看接手。
    peripheral.once("disconnect", () => {
      this._connected = false;
    });

    this._connected = true;
  }

  /** 寫 write 特徵（PC→裝置）。未連線時拋錯。 */
  async send(data: Uint8Array): Promise<void> {
    if (!this._connected || !this.writeChar) {
      throw new AppError(ErrorCode.IO_ERROR, "BLE 尚未連線，無法送出指令");
    }
    const buf = Buffer.from(data);
    try {
      // 第二參數 withoutResponse=false：要求對端確認，確保 RESUME / ACK 不漏。
      await this.promisify((cb) => this.writeChar!.write(buf, false, cb));
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        "BLE 寫入失敗",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** 清理：移除 notify 監聽、解訂閱、斷線、停掃描。可重複呼叫安全。 */
  async disconnect(): Promise<void> {
    this._connected = false;

    if (this.notifyChar && this.notifyHandler) {
      try {
        this.notifyChar.removeListener("data", this.notifyHandler);
        await this.promisify((cb) => this.notifyChar!.unsubscribe(cb));
      } catch {
        // 解訂閱失敗無妨（可能已斷線）
      }
    }
    this.notifyHandler = undefined;

    if (this.peripheral) {
      try {
        await this.promisify((cb) => this.peripheral.disconnect(cb));
      } catch {
        // 已斷線
      }
    }

    if (this.noble) {
      try {
        this.noble.stopScanning();
      } catch {
        // 沒在掃描
      }
    }

    this.peripheral = undefined;
    this.notifyChar = undefined;
    this.writeChar = undefined;
  }

  // ─────────────── 私有：noble 載入與 BLE 流程 ───────────────

  /**
   * 動態載入 noble。原生套件 + 無型別宣告，故用動態 import + as any，
   * 缺席（未安裝 / 此平台無法載入原生模組）時拋明確繁中錯誤。
   */
  private async loadNoble(): Promise<AnyNoble> {
    try {
      // 動態 import：頂層不 import，避免 typecheck / install 因 noble 缺席而失敗。
      // @abandonware/noble 為原生套件且未列為相依（可能未安裝）、亦無型別宣告，
      // 故 @ts-ignore 抑制 TS2307「找不到模組」；runtime 缺席時下方會轉成繁中 AppError。
      // （沿用本專案對 ffmpeg-static / selfsigned 等無型別套件的慣例。）
      // @ts-ignore noble 無型別宣告且非相依套件
      const mod = (await import("@abandonware/noble")) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const noble = mod?.default ?? mod;
      if (!noble || typeof noble.on !== "function") {
        throw new Error("noble 模組形狀異常");
      }
      return noble;
    } catch (err) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        "未安裝 noble 或此平台不支援 BLE",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** 等 noble state 變 poweredOn（藍牙開啟且介面卡就緒）。逾時拋 IO_ERROR。 */
  private waitPoweredOn(noble: AnyNoble): Promise<void> {
    if (noble.state === "poweredOn") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.removeListener("stateChange", onState);
        reject(new AppError(ErrorCode.IO_ERROR, "藍牙未就緒（poweredOn 逾時），請確認已開啟藍牙"));
      }, this.scanTimeoutMs);
      const onState = (state: string) => {
        if (state === "poweredOn") {
          clearTimeout(timer);
          noble.removeListener("stateChange", onState);
          resolve();
        }
      };
      noble.on("stateChange", onState);
    });
  }

  /** 掃描，找到第一個提供目標服務的裝置；逾時拋 IO_ERROR。 */
  private scanForPeripheral(noble: AnyNoble): Promise<AnyPeripheral> {
    return new Promise<AnyPeripheral>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        noble.removeListener("discover", onDiscover);
        try {
          noble.stopScanning();
        } catch {
          /* ignore */
        }
        reject(new AppError(ErrorCode.IO_ERROR, "找不到 PM01-9 錄音卡（掃描逾時）"));
      }, this.scanTimeoutMs);

      const onDiscover = (peripheral: AnyPeripheral) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        noble.removeListener("discover", onDiscover);
        try {
          noble.stopScanning();
        } catch {
          /* ignore */
        }
        resolve(peripheral);
      };

      noble.on("discover", onDiscover);
      try {
        // 只掃描帶目標服務的裝置；第二參 allowDuplicates=false。
        noble.startScanning([this.serviceUuid], false);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        noble.removeListener("discover", onDiscover);
        reject(
          new AppError(
            ErrorCode.IO_ERROR,
            "啟動 BLE 掃描失敗",
            err instanceof Error ? err.message : err,
          ),
        );
      }
    });
  }

  /** 取得 notify / write 特徵。找不到任一即拋 IO_ERROR。 */
  private async discoverCharacteristics(peripheral: AnyPeripheral): Promise<void> {
    const result = await new Promise<{ characteristics: AnyCharacteristic[] }>((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [this.serviceUuid],
        [this.notifyUuid, this.writeUuid],
        (err: Error | null, _services: unknown, characteristics: AnyCharacteristic[]) => {
          if (err) {
            reject(
              new AppError(ErrorCode.IO_ERROR, "探索 GATT 特徵失敗", err.message),
            );
            return;
          }
          resolve({ characteristics: characteristics ?? [] });
        },
      );
    });

    for (const ch of result.characteristics) {
      const uuid = normalizeUuid(String(ch.uuid));
      if (uuid === this.notifyUuid) this.notifyChar = ch;
      else if (uuid === this.writeUuid) this.writeChar = ch;
    }

    if (!this.notifyChar) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        `找不到 notify 特徵（${this.notifyUuid}）；UUID 需對照 PM01-9 原廠文件`,
      );
    }
    if (!this.writeChar) {
      throw new AppError(
        ErrorCode.IO_ERROR,
        `找不到 write 特徵（${this.writeUuid}）；UUID 需對照 PM01-9 原廠文件`,
      );
    }
  }

  /** 把 noble 的 callback 風格 API 包成 Promise。 */
  private promisify(fn: (cb: (err?: Error | null) => void) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fn((err) => (err ? reject(err) : resolve()));
    });
  }
}
