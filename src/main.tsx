import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// 關掉 webview 預設右鍵選單（上一頁/重新整理/另存新檔/列印…），
// 但輸入框/textarea/可編輯區保留（要用到貼上）。
document.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, [contenteditable=true]")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
