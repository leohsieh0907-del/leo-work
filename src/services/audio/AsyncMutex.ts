// ════════════════════════════════════════════════════════════════════
//  AsyncMutex — 非同步互斥鎖
//
//  Node 是單執行緒事件迴圈，沒有 Rust 那種真正的資料競爭；但「非同步區段」
//  之間仍會交錯（await 之間其他 callback 會插隊），導致狀態機/音訊寫入互踩。
//  此鎖把臨界區序列化（一次只跑一個 runExclusive），等同把規格要求的
//  Arc<Mutex> 語意對應到 TS runtime：保護共享狀態不被並發改寫。
// ════════════════════════════════════════════════════════════════════

export class AsyncMutex {
  /** 等待佇列的尾端 Promise；新進者鏈在它後面，達成 FIFO 序列化。 */
  private tail: Promise<void> = Promise.resolve();

  /**
   * 在持鎖狀態下執行 fn；fn 完成（含拋錯）後才釋放給下一位。
   * 回傳 fn 的結果。
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // 先佔位：把「目前的 tail」當成自己要等的前一位
    const previous = this.tail;
    let release!: () => void;
    // 立刻把 tail 換成「自己這一棒結束」的 Promise，後來者就會排在我後面
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous; // 等前一位放鎖
    try {
      return await fn();
    } finally {
      release(); // 放鎖給下一位（即使 fn 拋錯也保證釋放，避免死鎖）
    }
  }
}
