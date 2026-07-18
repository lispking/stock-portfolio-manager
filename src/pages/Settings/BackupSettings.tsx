import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Button,
  Switch,
  Space,
  Typography,
  message,
  Input,
  Alert,
  Descriptions,
} from "antd";
import {
  CloudUploadOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const { Text, Title } = Typography;

interface BackupConfig {
  directory: string | null;
  auto_backup: boolean;
  last_backup_mtime: number | null;
  last_backup_size: number | null;
  last_backup_time: string | null;
}

interface BackupResult {
  success: boolean;
  path: string | null;
  message: string | null;
}

function lastBackupLabel(config: BackupConfig | null): string {
  if (config?.last_backup_time) {
    return new Date(config.last_backup_time).toLocaleString("zh-CN");
  }
  if (config?.directory) return "尚未执行过备份";
  return "请先设置备份目录";
}

export default function BackupSettings() {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [backing, setBacking] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const c = await invoke<BackupConfig>("get_backup_config");
      setConfig(c);
    } catch (err) {
      console.error("Failed to load backup config:", err);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSelectDir = async () => {
    try {
      const isZh = navigator.language.startsWith("zh");
      const selected = await open({
        directory: true,
        multiple: false,
        title: isZh ? "选择备份目录" : "Select Backup Directory",
      });
      if (selected && typeof selected === "string" && config) {
        const newConfig = { ...config, directory: selected };
        await invoke("set_backup_config", { config: newConfig });
        setConfig(newConfig);
        message.success("备份目录已设置");
      }
    } catch (err) {
      message.error(`选择目录失败: ${err}`);
    }
  };

  const handleAutoBackup = async (checked: boolean) => {
    if (!config) return;
    const newConfig = { ...config, auto_backup: checked };
    try {
      await invoke("set_backup_config", { config: newConfig });
      setConfig(newConfig);
    } catch (err) {
      message.error(`设置失败: ${err}`);
    }
  };

  const handleBackup = async () => {
    if (!config?.directory) {
      message.warning("请先设置备份目录");
      return;
    }
    setBacking(true);
    try {
      const result = await invoke<BackupResult>("backup_database_now");
      if (result.success) {
        if (result.path) {
          message.success(`备份完成: ${result.path}`);
        } else if (result.message) {
          message.info(result.message);
        }
      } else {
        message.error(result.message ?? "备份失败");
      }
      await loadConfig();
    } catch (err) {
      message.error(`备份失败: ${err}`);
    } finally {
      setBacking(false);
    }
  };

  return (
    <div>
      <Title level={4}>💾 SQLite 备份</Title>
      <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
        将数据库文件备份到指定目录（如 NAS、共享文件夹等），防止数据丢失。
      </Text>

      <Alert
        type="info"
        showIcon
        className="mb-4"
        message="还原备份"
        description="将备份的 .db 文件复制到应用数据目录，覆盖 portfolio.db 文件后重启应用即可还原。"
      />

      {/* 备份目录设置 */}
      <Card size="small" title="📁 备份目录" className="mb-3">
        <Space>
          <Input
            value={config?.directory ?? ""}
            placeholder="点击选择目录"
            readOnly
            onClick={handleSelectDir}
            style={{ width: 420, cursor: "pointer" }}
          />
          <Button icon={<FolderOpenOutlined />} onClick={handleSelectDir}>
            选择目录
          </Button>
        </Space>
        <div style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            点击输入框或按钮选择目录。建议备份到 NAS 或其他机器，避免本机故障导致数据和备份同时丢失。
          </Text>
        </div>
      </Card>

      {/* 定期备份 */}
      <Card size="small" title="⏰ 定期备份" className="mb-3">
        <Space>
          <Switch
            checked={config?.auto_backup ?? false}
            onChange={handleAutoBackup}
          />
          <Text>
            {config?.auto_backup ? "已开启" : "已关闭"} — 应用启动时自动检查，若数据库有变动且距上次备份超 7 天则自动备份。
          </Text>
        </Space>
      </Card>

      {/* 手动备份 */}
      <Card size="small" title="操作">
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="备份状态">
              {config?.last_backup_time ? (
                <Text type="success">✅ 已备份</Text>
              ) : (
                <Text type="warning">
                  <ExclamationCircleOutlined /> 尚未备份
                </Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="上次备份时间">
              {lastBackupLabel(config)}
            </Descriptions.Item>
            <Descriptions.Item label="备份目录">
              {config?.directory || "—"}
            </Descriptions.Item>
          </Descriptions>

          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={handleBackup}
            loading={backing}
            disabled={!config?.directory}
          >
            立即备份
          </Button>
        </Space>
      </Card>
    </div>
  );
}
