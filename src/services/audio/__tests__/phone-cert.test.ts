import { describe, it, expect } from "vitest";
import { certAltNames } from "../PhoneBridgeServer";

describe("certAltNames（自簽憑證 SAN）", () => {
  it("含 localhost(DNS) + 127.0.0.1 + 傳入的區網 IP，全去重", () => {
    const alt = certAltNames(["192.168.0.204", "10.0.0.5"]);
    // localhost 為 DNS(type 2)
    expect(alt).toContainEqual({ type: 2, value: "localhost" });
    // 127.0.0.1 一定在（type 7 = IP）
    expect(alt).toContainEqual({ type: 7, ip: "127.0.0.1" });
    // 傳入的區網 IP 都在
    expect(alt).toContainEqual({ type: 7, ip: "192.168.0.204" });
    expect(alt).toContainEqual({ type: 7, ip: "10.0.0.5" });
  });

  it("重複 IP 去重、空白過濾", () => {
    const alt = certAltNames(["192.168.0.204", "192.168.0.204", "", "  "]);
    const ips = alt.filter((a) => a.type === 7).map((a) => a.ip);
    expect(ips.filter((ip) => ip === "192.168.0.204")).toHaveLength(1);
    expect(ips).not.toContain(""); // 空字串被濾掉
    expect(ips).toContain("127.0.0.1");
  });
});
