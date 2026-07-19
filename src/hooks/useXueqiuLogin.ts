import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { QuoteProviderConfig } from "../types";

/**
 * Drives the embedded Xueqiu (雪球) login flow.
 *
 * Two-step UX:
 *  1. `openLoginWindow()` – opens (or focuses) a separate OS window that loads
 *     `https://xueqiu.com/`. The user completes login inside it (scan QR,
 *     username/password, etc.).
 *  2. `capture()` – reads `xq_a_token` and `u` from that window's cookie store
 *     (via the Rust backend, which can see HttpOnly cookies) and persists them.
 *
 * We deliberately do NOT try to auto-detect login success by watching URL
 * changes, because Xueqiu's post-login URL is not deterministic. Instead the
 * user clicks an explicit "我已登录，抓取 Cookie" button in the main window.
 * This is the most reliable cross-platform approach.
 */
export function useXueqiuLogin() {
  const [loginWindowOpen, setLoginWindowOpen] = useState(false);

  // Re-derive `loginWindowOpen` from the actual Tauri window list on mount,
  // so the UI stays correct across reloads.
  useEffect(() => {
    let cancelled = false;
    WebviewWindow.getByLabel("xueqiu_login")
      .then((w) => {
        if (cancelled) return;
        setLoginWindowOpen(!!w);
      })
      .catch(() => {
        // Ignore – treated as "not open".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openLoginWindow = useCallback(async () => {
    // Reuse an existing window if one is already open.
    const existing = await WebviewWindow.getByLabel("xueqiu_login").catch(
      () => null
    );
    if (existing) {
      try {
        await existing.setFocus();
      } catch {
        // setFocus can fail on some platforms if the window is minimised; ignore.
      }
      setLoginWindowOpen(true);
      return;
    }

    const win = new WebviewWindow("xueqiu_login", {
      url: "https://xueqiu.com/",
      title: "登录雪球",
      width: 1100,
      height: 760,
      resizable: true,
      minimizable: true,
      maximizable: true,
      // Keep this window out of the taskbar on platforms that support it so
      // it feels like a modal helper rather than a second app window.
      skipTaskbar: false,
    });

    win.once("tauri://created", () => {
      setLoginWindowOpen(true);
    });
    win.once("tauri://error", (e) => {
      console.error("Failed to open Xueqiu login window:", e);
      setLoginWindowOpen(false);
      throw new Error("无法打开雪球登录窗口");
    });
    win.once("tauri://destroyed", () => {
      setLoginWindowOpen(false);
    });
  }, []);

  const capture = useCallback(async (): Promise<QuoteProviderConfig> => {
    return invoke<QuoteProviderConfig>("capture_xueqiu_cookies");
  }, []);

  return {
    /** Whether the login window is currently believed to be open. */
    loginWindowOpen,
    /** Open (or focus) the embedded Xueqiu login window. */
    openLoginWindow,
    /** Pull `xq_a_token` and `u` from the login window and persist them. */
    capture,
  };
}
