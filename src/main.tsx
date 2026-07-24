import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { useTheme } from "./hooks/useTheme";
import "./styles/global.css";

function ThemedApp() {
  const { algorithm } = useTheme();

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm }}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemedApp />
    </BrowserRouter>
  </React.StrictMode>
);
