// ════════════════════════════════════════════════════════════════════
//  手機跨裝置音訊橋接（HTTPS/WSS + QR + Token）
//
//  手機端用 getUserMedia 收音，需安全環境（HTTPS/WSS）才放行——區網 IP 走純
//  http 會被瀏覽器擋。本伺服器以自簽憑證起 https.createServer，並掛 ws 的
//  WebSocketServer(path:"/ws")；另由同一 https server 提供手機頁面 GET /m。
//
//  生命週期：
//    - 建構時即產生 token（crypto.randomBytes）與偵測區網 IP。
//    - getSession()：確保伺服器已啟動，回 QR / token / url。
//    - start(onChunk,onError)：開始把手機音訊幀轉發給上層。
//    - stop()：停止轉發，但「不關伺服器」——QR/連線維持有效，方便反覆收音。
//    - connected：是否有手機 WS 連著。
//
//  二進位音訊幀格式（與 phonePage.ts 嚴格對齊）：
//    [uint32 LE seq][float64 LE timestampMs][Int16 LE PCM 16kHz mono...]
//  解析後組成 AudioChunk{ seq, timestampMs, samples(Float32 /32768), source:"phone" }。
//  seq 由手機端維持連續，伺服器不重設，交給上層 AudioSync 對齊。
// ════════════════════════════════════════════════════════════════════

import https from "node:https";
import os from "node:os";
import crypto from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";
import QRCode from "qrcode";
// selfsigned 無內建型別宣告；以下 default import 在無 .d.ts 時會報 7016，
// 故加 @ts-ignore。執行期為合法的 CommonJS default interop（esModuleInterop=true）。
// @ts-ignore selfsigned 缺型別宣告
import selfsigned from "selfsigned";

import type { AudioChunk, PhoneBridge } from "./types";
import { PHONE_PAGE_HTML } from "./phonePage";
import { AppError, ErrorCode, type PhoneSession } from "../../shared/types";

export interface PhoneBridgeOptions {
  /** WSS / HTTPS 監聽埠，預設 8443。 */
  port?: number;
  /** 綁定位址，預設 0.0.0.0（讓區網手機連得到）。 */
  host?: string;
}

/** 二進位幀標頭長度：uint32 seq(4) + float64 timestampMs(8)。 */
const HEADER_BYTES = 12;

/**
 * 呼叫一個「吃 callback 的 close 函式」，並加上逾時保險：
 * 回呼觸發即 resolve；逾時則直接放行（避免外部 server + 殘留連線時回呼不觸發而卡死）。
 */
function closeWithTimeout(closeFn: (cb: () => void) => void, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (typeof timer.unref === "function") timer.unref();
    try {
      closeFn(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export class PhoneBridgeServer implements PhoneBridge {
  private readonly port: number;
  private readonly host: string;
  private readonly token: string;
  private readonly lanIp: string;

  private httpsServer: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private starting: Promise<void> | null = null; // 啟動去重，避免併發 getSession 多開

  /** 目前連著的手機 WS（同時只接受一台）。 */
  private phoneWs: WebSocket | null = null;

  /** start() 後才有值：把解析好的音訊塊往上轉發。 */
  private onChunk: ((chunk: AudioChunk) => void) | null = null;
  private onError: ((err: Error) => void) | null = null;

  constructor(opts: PhoneBridgeOptions = {}) {
    this.port = opts.port ?? 8443;
    this.host = opts.host ?? "0.0.0.0";
    // 建構時即產生 token，整個 server 生命週期固定；手機重連沿用同一 token。
    this.token = crypto.randomBytes(24).toString("hex");
    this.lanIp = detectLanIp();
  }

  // ─────────────── PhoneBridge：連線狀態 ───────────────

  get connected(): boolean {
    return this.phoneWs !== null && this.phoneWs.readyState === this.phoneWs.OPEN;
  }

  // ─────────────── getSession：確保啟動並回 QR / token / url ───────────────

  /**
   * 回 QR / token / url。`preferredIp` 可指定要用哪個區網 IP（多網卡時讓使用者選與手機
   * 同網段的那個）；未指定或不在候選內則用偵測到的預設。candidates 為目前所有可用 IP。
   */
  async getSession(preferredIp?: string): Promise<PhoneSession> {
    await this.ensureStarted();
    // 每次重抓候選（網路可能在啟動後才變動，例如插拔 tether / 連上 Wi-Fi）。
    const candidates = listLanIps();
    const ip =
      preferredIp && candidates.includes(preferredIp)
        ? preferredIp
        : (candidates[0] ?? this.lanIp);
    const url = `https://${ip}:${this.port}/m?token=${this.token}`;
    let qrDataUrl: string;
    try {
      qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
    } catch (err) {
      throw new AppError(ErrorCode.IO_ERROR, "產生 QR Code 失敗", errMsg(err));
    }
    return { url, token: this.token, qrDataUrl, lanIp: ip, port: this.port, candidates };
  }

  // ─────────────── start / stop：轉發開關 ───────────────

  /**
   * 開始把手機音訊轉發給上層。會確保伺服器已啟動。
   * 設計選擇：start 前若手機已連上，其音訊幀會被「丟棄」（不緩衝），
   * 因為收音語意上應從使用者按下開始算起，緩衝舊資料反而污染逐字稿。
   */
  async start(onChunk: (c: AudioChunk) => void, onError: (e: Error) => void): Promise<void> {
    await this.ensureStarted();
    this.onChunk = onChunk;
    this.onError = onError;
  }

  /** 停止轉發；伺服器與手機連線「維持」，QR 持續有效，方便再次開始。 */
  async stop(): Promise<void> {
    this.onChunk = null;
    this.onError = null;
  }

  /** 完整關閉伺服器與所有連線（給程式結束 / 測試清理用）。 */
  async close(): Promise<void> {
    this.onChunk = null;
    this.onError = null;

    // 先強制終止手機連線（terminate 立即斷，不等關閉握手）
    if (this.phoneWs) {
      try {
        this.phoneWs.removeAllListeners();
        this.phoneWs.terminate();
      } catch {
        /* 忽略關閉期間的例外 */
      }
      this.phoneWs = null;
    }

    const wss = this.wss;
    const server = this.httpsServer;
    this.wss = null;
    this.httpsServer = null;
    this.starting = null;

    // 強制終止所有 WS client 與底層連線，避免 close() 回呼因殘留連線而不觸發
    if (wss) {
      for (const c of wss.clients) {
        try {
          c.terminate();
        } catch {
          /* 忽略 */
        }
      }
    }
    server?.closeAllConnections?.(); // Node 18.2+：強制關掉 keep-alive / 半開連線

    // wss.close / server.close 都加逾時保險：回呼不觸發時最多等一下就放行，杜絕卡死。
    if (wss) await closeWithTimeout((cb) => wss.close(cb), 1500);
    if (server) await closeWithTimeout((cb) => server.close(cb), 1500);
  }

  // ─────────────── 內部：啟動 HTTPS + WSS（只啟動一次）───────────────

  private ensureStarted(): Promise<void> {
    if (this.httpsServer && this.wss) return Promise.resolve();
    if (this.starting) return this.starting; // 併發呼叫共用同一個啟動 Promise
    this.starting = this.boot().catch((err) => {
      this.starting = null; // 失敗可重試
      throw err;
    });
    return this.starting;
  }

  private async boot(): Promise<void> {
    let key: string;
    let cert: string;
    try {
      // 自簽憑證：手機 getUserMedia 需安全環境。CN 用區網 IP，效期一年。
      const pems = selfsigned.generate(
        [{ name: "commonName", value: this.lanIp }],
        { days: 365, keySize: 2048, algorithm: "sha256" },
      );
      key = pems.private;
      cert = pems.cert;
    } catch (err) {
      throw new AppError(ErrorCode.IO_ERROR, "產生自簽憑證失敗", errMsg(err));
    }

    const server = https.createServer({ key, cert }, (req, res) => {
      // 只提供手機頁面，其餘一律 404（伺服器僅為橋接而生，不當通用 web server）
      const pathname = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && pathname === "/m") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(PHONE_PAGE_HTML);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    });

    // WSS：掛在同一 https server 的 /ws 路徑；連線時用 query token 驗證。
    const wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: (info, done) => {
        const ok = this.tokenMatches(info.req.url);
        // token 不符直接拒絕握手（HTTP 401），不浪費資源建立 WS。
        done(ok, ok ? undefined : 401, "未授權");
      },
    });

    wss.on("connection", (ws) => this.onPhoneConnection(ws));
    wss.on("error", (err) => this.onError?.(toError(err)));

    this.httpsServer = server;
    this.wss = wss;

    // 啟動監聽（綁 0.0.0.0 讓區網手機連得到）
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => {
        server.off("listening", onOk);
        reject(
          new AppError(ErrorCode.IO_ERROR, `手機橋接伺服器無法在埠 ${this.port} 啟動`, err.message),
        );
      };
      const onOk = () => {
        server.off("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onOk);
      server.listen(this.port, this.host);
    });
  }

  // ─────────────── WS 連線驗證與處理 ───────────────

  /** 比對連線網址帶的 ?token= 是否與本 server 的 token 相符（定時比較防側信道）。 */
  private tokenMatches(rawUrl: string | undefined): boolean {
    if (!rawUrl) return false;
    let provided: string | null;
    try {
      provided = new URL(rawUrl, "http://localhost").searchParams.get("token");
    } catch {
      return false;
    }
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false; // 長度不同直接否決（timingSafeEqual 要求等長）
    return crypto.timingSafeEqual(a, b);
  }

  private onPhoneConnection(ws: WebSocket): void {
    // verifyClient 已通過 token 驗證才會走到這裡。
    // 同時只接受一台手機：新連線「取代」舊連線（行動裝置切前後台常重連，
    // 取代比拒絕體驗好；舊連線以 1000 正常關閉）。
    if (this.phoneWs && this.phoneWs !== ws) {
      try {
        this.phoneWs.removeAllListeners();
        this.phoneWs.close(1000, "被新連線取代");
      } catch {
        /* 忽略 */
      }
    }
    this.phoneWs = ws;

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return; // 只處理二進位音訊幀，忽略任何文字訊息
      this.handleFrame(toBuffer(data));
    });

    ws.on("close", () => {
      if (this.phoneWs === ws) this.phoneWs = null;
    });

    ws.on("error", (err) => {
      if (this.phoneWs === ws) this.phoneWs = null;
      this.onError?.(toError(err));
    });
  }

  // ─────────────── 解析二進位幀 → AudioChunk ───────────────

  private handleFrame(buf: Buffer): void {
    // start() 前（未注入 onChunk）：丟棄音訊，不緩衝（見 start 註解）。
    const sink = this.onChunk;
    if (!sink) return;

    // 至少要有完整 header；PCM 位元組數須為偶數（Int16 對齊）。
    if (buf.length < HEADER_BYTES) return;
    const pcmBytes = buf.length - HEADER_BYTES;
    if (pcmBytes % 2 !== 0) return;

    const seq = buf.readUInt32LE(0);
    const timestampMs = buf.readDoubleLE(4);

    const sampleCount = pcmBytes / 2;
    const samples = new Float32Array(sampleCount);
    let off = HEADER_BYTES;
    for (let i = 0; i < sampleCount; i++) {
      // Int16 LE → Float32（-1..1）：除以 32768，與手機端 0x8000/0x7fff 編碼對應。
      samples[i] = buf.readInt16LE(off) / 32768;
      off += 2;
    }

    const chunk: AudioChunk = { seq, timestampMs, samples, source: "phone" };
    try {
      sink(chunk);
    } catch (err) {
      this.onError?.(toError(err));
    }
  }
}

// ─────────────── 工具函式 ───────────────

/** 虛擬 / 不適合手機連線的網卡名稱（往候選清單後面排）。 */
const VIRTUAL_IFACE_RE =
  /(vEthernet|Hyper-V|VMware|VirtualBox|VBox|WSL|Loopback|Bluetooth|TAP|Tailscale|ZeroTier|Docker|Default Switch)/i;

/**
 * 列出可當手機連線目標的區網 IPv4 候選。
 * 排除：internal、169.254.x.x（APIPA link-local，沒連上 DHCP，手機連不到）。
 * 排序：實體網卡（Wi-Fi/乙太）優先，虛擬網卡（Hyper-V/VMware/WSL…）往後。
 * 多網卡時交給 UI 讓使用者選與手機同網段的那個。
 */
function listLanIps(): string[] {
  const ifaces = os.networkInterfaces();
  const real: string[] = [];
  const virt: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      // Node 18+ 的 family 可能是 string("IPv4") 或 number(4)，兩種都判。
      const isIpv4 = addr.family === "IPv4" || (addr.family as unknown as number) === 4;
      if (!isIpv4 || addr.internal) continue;
      if (addr.address.startsWith("169.254.")) continue; // APIPA：未連上正常網路，排除
      (VIRTUAL_IFACE_RE.test(name) ? virt : real).push(addr.address);
    }
  }
  return [...real, ...virt];
}

/** 偵測預設區網 IP（候選清單第一個）；找不到退回 127.0.0.1。 */
function detectLanIp(): string {
  return listLanIps()[0] ?? "127.0.0.1";
}

/** 把 ws 傳來的多型 data 正規化成單一 Buffer。 */
function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : "手機橋接未知錯誤");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
