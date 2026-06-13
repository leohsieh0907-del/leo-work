// ════════════════════════════════════════════════════════════════════
//  PhoneBridgeServer 整合測試（vitest，實跑）
//
//  真的起一台 HTTPS/WSS 伺服器（隨機高位埠），用 ws 當手機端 client 連線，
//  送出符合二進位幀格式的封包，驗證伺服器解析回 AudioChunk 正確。
//
//  自簽憑證的 CN 是區網 IP，但 client 連 127.0.0.1，故 TLS 主機名不符——
//  以 rejectUnauthorized:false 關閉驗證（測試情境合理，正式手機端由使用者
//  在瀏覽器點「仍要前往」接受自簽憑證）。
//
//  幀格式（與 PhoneBridgeServer / phonePage 對齊）：
//    [uint32 LE seq][float64 LE timestampMs][Int16 LE PCM 16kHz mono...]
//
//  涵蓋：
//   1. 正確 token 連線 + 送一幀 → onChunk 收到 {seq, source:"phone", 樣本長度/值還原}
//   2. 錯誤 token 連線 → 被伺服器拒絕（握手失敗 → client error/close）
//   3. afterAll 清理 server 與 client，避免測試掛住
// ════════════════════════════════════════════════════════════════════

import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { PhoneBridgeServer } from "../PhoneBridgeServer";
import type { AudioChunk } from "../types";

// 隨機高位埠，降低與其他服務衝突機率
const PORT = 30000 + Math.floor(Math.random() * 20000);

const bridge = new PhoneBridgeServer({ port: PORT });
const openSockets: WebSocket[] = [];

/** 建一個連到本機橋接 WSS 的 client；rejectUnauthorized:false 接受自簽憑證。 */
function makeClient(token: string): WebSocket {
  const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws?token=${token}`, {
    rejectUnauthorized: false,
  });
  openSockets.push(ws);
  return ws;
}

/** 依約定組裝一個二進位音訊幀。 */
function buildFrame(seq: number, timestampMs: number, samples: number[]): Buffer {
  const HEADER = 12;
  const buf = Buffer.alloc(HEADER + samples.length * 2);
  buf.writeUInt32LE(seq >>> 0, 0);
  buf.writeDoubleLE(timestampMs, 4);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], HEADER + i * 2);
  }
  return buf;
}

afterAll(async () => {
  for (const ws of openSockets) {
    ws.removeAllListeners();
    // 補一個 error 吞噬器：terminate() 在「連線尚未建立(CONNECTING)」的 socket 上
    // 會非同步 emit 'error'，若無監聽器會變成未捕捉例外讓 hook 失敗。
    ws.on("error", () => {});
    try {
      ws.terminate();
    } catch {
      /* 忽略 */
    }
  }
  await bridge.close();
});

describe("PhoneBridgeServer 整合", () => {
  it("正確 token：送一幀 → onChunk 收到正確解析的 AudioChunk", async () => {
    const session = await bridge.getSession();
    expect(session.token).toMatch(/^[0-9a-f]+$/);
    expect(session.port).toBe(PORT);
    expect(session.url).toContain(`/m?token=${session.token}`);
    expect(session.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // 等 onChunk 被呼叫
    const received = new Promise<AudioChunk>((resolve, reject) => {
      const onChunk = (c: AudioChunk) => resolve(c);
      const onError = (e: Error) => reject(e);
      // 必須先 start 才會轉發（start 前的幀會被丟棄）
      bridge.start(onChunk, onError).catch(reject);
    });

    // 連線並在 open 後送出一幀
    const client = makeClient(session.token);
    // Int16 樣本：涵蓋極值與一般值，驗證 /32768 還原
    const SAMPLES = [0, 16384, -16384, 32767, -32768, 1000];
    const TS = 1_700_000_000_123.5; // 帶小數，驗證 float64 不被截斷
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(buildFrame(5, TS, SAMPLES), { binary: true }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      client.on("error", reject);
    });

    const chunk = await received;
    expect(chunk.source).toBe("phone");
    expect(chunk.seq).toBe(5);
    expect(chunk.timestampMs).toBe(TS);
    expect(chunk.samples.length).toBe(SAMPLES.length);

    // 樣本值約略還原（Int16/32768），容忍浮點誤差
    const expected = SAMPLES.map((v) => v / 32768);
    for (let i = 0; i < expected.length; i++) {
      expect(chunk.samples[i]).toBeCloseTo(expected[i], 5);
    }

    // 此時應反映「有手機連著」
    expect(bridge.connected).toBe(true);
  });

  it("錯誤 token：連線應被伺服器拒絕（握手失敗）", async () => {
    const bad = makeClient("definitely-wrong-token");

    const rejected = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      // 401 拒絕握手 → 'unexpected-response' / 'error'；不會走到 'open'
      bad.on("unexpected-response", () => done(true));
      bad.on("error", () => done(true));
      bad.on("close", () => done(true));
      bad.on("open", () => done(false)); // 不該發生
      // 保險：逾時也視為通過（連不上即被拒）
      setTimeout(() => done(true), 3000);
    });

    expect(rejected).toBe(true);
  });

  it("stop 後不再轉發：停止轉發後送幀不應觸發 onChunk", async () => {
    // 先 start 掛一個 sink，再 stop 清掉；之後送幀都不應該觸發它
    let got = false;
    await bridge.start(
      () => {
        got = true;
      },
      () => {
        /* 忽略 */
      },
    );
    await bridge.stop();

    const session = await bridge.getSession();
    const client = makeClient(session.token);

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(buildFrame(99, Date.now(), [1, 2, 3]), { binary: true }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      client.on("error", reject);
    });

    // 給伺服器一點時間處理（若會誤轉發，got 會被設成 true）
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toBe(false);
  });
});
