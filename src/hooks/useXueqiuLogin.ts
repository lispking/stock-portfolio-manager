import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { QuoteProviderConfig } from "../types";

/**
 * Drives the embedded Xueqiu (雪球) login flow.
 *
 * The login window loads `https://xueqiu.com/`. The user logs in there (QR /
 * password), then EITHER clicks "我已登录，抓取 Cookie" in the main window OR
 * simply closes the login window — both paths trigger `capture()`.
 *
 * Auto-capture on close: we intercept the login window's `closeRequested`
 * event, prevent the default close, run `capture_xueqiu_cookies`, and then
 * the backend closes the window itself. At close time the webview cookie
 * store still holds the session cookies, so this works even though the user
 * never returns to the main window.
 *
 * Cookie capture itself is done by the Rust backend via
 * `WebviewWindow::cookies_for_url`, which can read HttpOnly cookies that JS
 * (`document.cookie`) cannot.
 *
 * Result delivery: rather than broadcasting a global Tauri event (which is
 * hard to dedupe under React StrictMode / HMR / multiple component instances),
 * the hook invokes `onCaptured` directly. The caller passes a stable callback
 * (useCallback) so only one toast fires per capture.
 *
 * @param onCaptured called with the freshly persisted config when capture
 *                   succeeds, whether triggered by the explicit button or by
 *                   window close.
 */
export function useXueqiuLogin(onCaptured?: (config: QuoteProviderConfig) => void) {
  const [loginWindowOpen, setLoginWindowOpen] = useState(false);
  // Hold the latest callback in a ref so the window listener (registered once
  // per window lifecycle) always calls the freshest closure without needing
  // to re-register when the callback identity changes.
  const onCapturedRef = useRef(onCaptured);
  useEffect(() => {
    onCapturedRef.current = onCaptured;
  });

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
    // Reuse an existing window if one is already open. The close listener is
    // attached at window-creation time, so re-focus does NOT add another.
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
      skipTaskbar: false,
    });

    // Keep a local flag so the close handler short-circuits if the window is
    // already being torn down (avoids duplicate capture/invoke races).
    let closing = false;

    win.once("tauri://created", () => {
      setLoginWindowOpen(true);

      // Auto-capture on close. We intercept the close so the webview cookie
      // store is still alive, then ask the backend to capture AND close the
      // window itself. Closing from the backend is reliable across platforms.
      win
        .onCloseRequested(async (event) => {
          if (closing) return;
          closing = true;
          event.preventDefault();
          try {
            const config = await invoke<QuoteProviderConfig>(
              "capture_xueqiu_cookies",
              { closeWindow: true }
            );
            onCapturedRef.current?.(config);
          } catch (e) {
            // Capture failed (e.g. user hadn't logged in yet). The backend has
            // already closed the window because closeWindow=true; nothing more
            // to do here. This is an expected, benign path.
            console.info("Xueqiu login window closed without capture:", e);
          } finally {
            setLoginWindowOpen(false);
          }
        })
        .catch(() => {
          // Listener registration failure is non-fatal.
        });
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
    const config = await invoke<QuoteProviderConfig>("capture_xueqiu_cookies");
    onCapturedRef.current?.(config);
    return config;
  }, []);

  return {
    /** Whether the login window is currently believed to be open. */
    loginWindowOpen,
    /** Open (or focus) the embedded Xueqiu login window. */
    openLoginWindow,
    /**
     * Pull `xq_a_token` and `u` from the login window and persist them.
     * Also fires `onCaptured`. Throws if capture fails.
     */
    capture,
  };
}
