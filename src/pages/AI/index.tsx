import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Form,
  Input,
  Button,
  Select,
  Typography,
  Alert,
  message,
  Divider,
  Space,
  Tooltip,
  Switch,
} from "antd";
import {
  RobotOutlined,
  SaveOutlined,
  ReloadOutlined,
  EditOutlined,
  InfoCircleOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { useAiStore } from "../../stores/aiStore";
import type { AiModelInfo, AiProvider } from "../../types";

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

interface ProviderOption {
  value: AiProvider;
  label: string;
  hint: string;
  default_base_url?: string;
  needs_key: boolean;
  key_placeholder?: string;
}

/** The providers we support. All expose an OpenAI-compatible `/models`
 *  endpoint, so models are always fetched dynamically from the API. */
const PROVIDERS: ProviderOption[] = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "官方 OpenAI API（ChatGPT 背后的服务）",
    default_base_url: "https://api.openai.com/v1",
    needs_key: true,
    key_placeholder: "sk-...",
  },
  {
    value: "ollama",
    label: "Ollama（本地）",
    hint: "本地运行的 Ollama 服务，无需 API Key",
    default_base_url: "http://localhost:11434",
    needs_key: false,
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "聚合多家模型（OpenAI、Google、Meta 等），OpenAI 兼容 API",
    default_base_url: "https://openrouter.ai/api/v1",
    needs_key: true,
    key_placeholder: "sk-or-...",
  },
  {
    value: "kimi",
    label: "Kimi（月之暗面）",
    hint: "国内 Kimi / Moonshot，OpenAI 兼容 API",
    default_base_url: "https://api.moonshot.ai/v1",
    needs_key: true,
    key_placeholder: "sk-...",
  },
  {
    value: "glm",
    label: "GLM（智谱）",
    hint: "智谱 GLM 系列模型，OpenAI 兼容 API（v4 端点）",
    default_base_url: "https://open.bigmodel.cn/api/paas/v4",
    needs_key: true,
    key_placeholder: "xxx.xxx",
  },
  {
    value: "mimo",
    label: "MiMo（小米）",
    hint: "小米 MiMo 大模型开放平台，OpenAI 兼容 API",
    default_base_url: "https://api.xiaomimimo.com/v1",
    needs_key: true,
    key_placeholder: "sk-...",
  },
  {
    value: "deepseek",
    label: "DeepSeek（深度求索）",
    hint: "DeepSeek 官方 API，OpenAI 兼容",
    default_base_url: "https://api.deepseek.com",
    needs_key: true,
    key_placeholder: "sk-...",
  },
];

function providerOf(value: string): ProviderOption | undefined {
  return PROVIDERS.find((p) => p.value === value);
}

export default function AIPage() {
  const { config, loading, fetchConfig, updateConfig, fetchModels, getDefaultSystemPrompt } =
    useAiStore();
  const [form] = Form.useForm();
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [manualModel, setManualModel] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleRestorePrompt = async () => {
    try {
      const def = await getDefaultSystemPrompt();
      form.setFieldValue("system_prompt", def);
      message.success("已恢复默认提示词（需点击保存生效）");
    } catch (err) {
      message.error("恢复失败：" + String(err));
    }
  };

  useEffect(() => {
    if (config) {
      form.setFieldsValue({
        provider: config.provider,
        api_key: config.api_key,
        model: config.model,
        base_url: config.base_url || "",
        system_prompt: config.system_prompt,
      });
      // If the saved model isn't empty but also isn't in any list we know,
      // default to manual mode so the user can still see/edit it.
      setManualModel(Boolean(config.model));
    }
  }, [config, form]);

  const selectedProvider = Form.useWatch("provider", form);
  const apiKey = Form.useWatch("api_key", form);
  const baseUrl = Form.useWatch("base_url", form);

  const provider = useMemo(
    () => providerOf(selectedProvider ?? "") ?? PROVIDERS[0],
    [selectedProvider],
  );

  const handleFetchModels = async () => {
    if (provider.needs_key && !apiKey) {
      message.warning("请先填写 API Key");
      return;
    }
    setModelsLoading(true);
    try {
      const list = await fetchModels({
        provider: provider.value,
        api_key: apiKey,
        base_url: baseUrl || null,
      });
      setModels(list);
      if (list.length === 0) {
        message.info("API 未返回任何模型，请手动输入模型名称");
        setManualModel(true);
      } else {
        message.success(`已获取 ${list.length} 个模型`);
        // Keep manual mode off unless the current model isn't in the list.
        const current = form.getFieldValue("model");
        if (current && !list.some((m) => m.id === current)) {
          form.setFieldValue("model", list[0].id);
        } else if (!current) {
          form.setFieldValue("model", list[0].id);
        }
        setManualModel(false);
      }
    } catch (err) {
      message.error("获取模型失败：" + String(err) + "，请改为手动输入");
      setManualModel(true);
    } finally {
      setModelsLoading(false);
    }
  };

  // Auto-fetch models when the user has entered a key (for key-less providers,
  // immediately on selection) and picks a provider. All supported providers
  // expose an OpenAI-compatible `/models` endpoint.
  useEffect(() => {
    if (
      selectedProvider &&
      (provider.needs_key ? Boolean(apiKey) : true) &&
      !manualModel
    ) {
      handleFetchModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const success = await updateConfig({
        provider: values.provider,
        api_key: values.api_key,
        model: values.model,
        base_url: values.base_url || null,
        system_prompt: values.system_prompt,
      });
      if (success) {
        message.success("AI 配置已保存");
      }
    } catch (err) {
      message.error("保存失败: " + String(err));
    }
  };

  const modelOptions = useMemo(
    () =>
      models.map((m) => ({
        value: m.id,
        label: m.name ? `${m.name}（${m.id}）` : m.id,
      })),
    [models],
  );

  return (
    <div className="space-y-6">
      <Title level={2}>
        <RobotOutlined /> AI 投资分析（实验性）
      </Title>

      <Alert
        type="info"
        title="实验性功能"
        description="支持 OpenAI、Ollama、OpenRouter 以及 Kimi、GLM（智谱）、MiMo（小米）、DeepSeek 等主流服务。填写 API Key 后可自动获取可用模型列表，获取失败时也可手动输入。API Key 仅本地存储，不会上传。使用前请确保 API Key 有效，并了解相关费用。"
        showIcon
      />

      <Card title="API 配置">
        <Form form={form} layout="vertical" style={{ maxWidth: 600 }}>
          <Form.Item name="provider" label="AI 提供商" rules={[{ required: true }]}>
            <Select
              options={PROVIDERS.map((p) => ({
                value: p.value,
                label: (
                  <Space>
                    <span>{p.label}</span>
                    <Tooltip title={p.hint}>
                      <InfoCircleOutlined style={{ color: "#999" }} />
                    </Tooltip>
                  </Space>
                ),
              }))}
            />
          </Form.Item>

          <Form.Item
            name="api_key"
            label={
              <Space>
                API Key
                {provider.needs_key ? null : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （该提供商不需要）
                  </Text>
                )}
              </Space>
            }
            rules={
              provider.needs_key
                ? [{ required: true, message: "请输入 API Key" }]
                : []
            }
          >
            <Input.Password placeholder={provider.key_placeholder ?? ""} />
          </Form.Item>

          <Form.Item
            name="base_url"
            label={
              <Space>
                API 端点
                <Text type="secondary" style={{ fontSize: 12 }}>
                  （留空使用默认：{provider.default_base_url ?? "—"}）
                </Text>
              </Space>
            }
          >
            <Input placeholder={provider.default_base_url ?? ""} />
          </Form.Item>

          <Form.Item
            name="model"
            label={
              <Space
                style={{ justifyContent: "space-between", width: "100%" }}
              >
                <span>模型</span>
                <Space size="small">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    手动输入
                  </Text>
                  <Switch
                    size="small"
                    checked={manualModel}
                    onChange={(v) => {
                      setManualModel(v);
                      if (v) {
                        setModels([]);
                      }
                    }}
                  />
                  <Button
                    size="small"
                    type="link"
                    icon={<ReloadOutlined />}
                    loading={modelsLoading}
                    onClick={handleFetchModels}
                    disabled={manualModel}
                  >
                    获取模型
                  </Button>
                </Space>
              </Space>
            }
            rules={[{ required: true, message: "请选择或输入模型" }]}
          >
            {manualModel ? (
              <Input
                prefix={<EditOutlined />}
                placeholder="例如：gpt-4o、claude-3-7-sonnet、llama3.2 ..."
              />
            ) : (
              <Select
                showSearch
                placeholder="点击「获取模型」拉取可用模型"
                options={modelOptions}
                notFoundContent={
                  modelsLoading
                    ? "加载中..."
                    : "暂无模型，请点击「获取模型」或切换为手动输入"
                }
              />
            )}
          </Form.Item>

          <Form.Item
            name="system_prompt"
            label={
              <Space
                style={{ justifyContent: "space-between", width: "100%" }}
              >
                <span>系统提示词</span>
                <Button
                  size="small"
                  type="link"
                  icon={<UndoOutlined />}
                  onClick={handleRestorePrompt}
                >
                  恢复默认
                </Button>
              </Space>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                定义 AI 的角色、职责与回答风格。AI 会自动收到一份当前持仓与绩效的快照作为上下文，无需在此重复填写。
              </Text>
            }
          >
            <TextArea
              rows={10}
              placeholder="例如：你是一位经验丰富、客观中立的个人投资组合分析助手..."
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={loading}
              onClick={handleSave}
            >
              保存配置
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="功能说明">
        <Paragraph>配置完成后，AI 分析功能可以帮助你：</Paragraph>
        <ul className="list-disc list-inside space-y-1">
          <li>分析持仓集中度和风险分布</li>
          <li>基于持仓历史生成季度回顾总结</li>
          <li>提供个性化的投资建议</li>
          <li>分析操作决策的质量和改进方向</li>
        </ul>
        <Divider />
        <Text type="secondary">
          注意：AI 分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。
        </Text>
      </Card>
    </div>
  );
}
