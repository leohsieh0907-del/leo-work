// 把 Node sidecar 組裝成 Tauri 可打包的形式（每個 OS 在自己的 runner 上跑一次）：
//   src-tauri/sidecar/server.cjs              ← esbuild 打包（原生模組外部化）
//   src-tauri/sidecar/node_modules/…          ← 三個原生外部模組(含平台原生 .node / ffmpeg)
//   src-tauri/binaries/leo-node-<triple>(.exe)← 當前平台的 Node runtime（Tauri externalBin）
//
// 為何複製 process.execPath：assemble 由 Node 執行，這支 node 本身就是「當前平台」的
// runtime，直接複製當 sidecar 解譯器，CI runner 不必另外下載 Node。
import { execSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = join(root, "src-tauri", "sidecar");
const binDir = join(root, "src-tauri", "binaries");
const EXTERNALS = ["@lancedb/lancedb", "@xenova/transformers", "ffmpeg-static"];

// Rust target triple 後綴（Tauri externalBin 命名規則：<name>-<triple>）
function tripleSuffix() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

console.log("[assemble] 清理舊產物…");
rmSync(sidecarDir, { recursive: true, force: true });
mkdirSync(sidecarDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

console.log("[assemble] esbuild 打包 server.cjs…");
execSync(
  `npx esbuild src/server.ts --bundle --platform=node --format=cjs ` +
    `--outfile="${join(sidecarDir, "server.cjs")}" ` +
    EXTERNALS.map((e) => `--external:${e}`).join(" "),
  { cwd: root, stdio: "inherit" },
);

console.log("[assemble] 安裝原生外部模組(含平台原生檔)…");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sidecarPkg = {
  name: "leo-sidecar-runtime",
  private: true,
  dependencies: Object.fromEntries(
    EXTERNALS.map((e) => {
      const v = rootPkg.dependencies?.[e];
      if (!v) throw new Error(`根 package.json 找不到外部模組 ${e} 的版本`);
      return [e, v];
    }),
  ),
};
writeFileSync(join(sidecarDir, "package.json"), JSON.stringify(sidecarPkg, null, 2));
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: sidecarDir, stdio: "inherit" });

console.log("[assemble] 複製當前平台 Node runtime 作為 externalBin…");
const ext = process.platform === "win32" ? ".exe" : "";
const dest = join(binDir, `leo-node-${tripleSuffix()}${ext}`);
copyFileSync(process.execPath, dest);
if (process.platform !== "win32") chmodSync(dest, 0o755);

console.log(`[assemble] 完成 → ${dest}`);
