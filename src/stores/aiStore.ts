import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AiConfig, AiModelInfo } from "../types";

interface FetchModelsArgs {
  provider: string;
  api_key?: string;
  base_url?: string | null;
}

interface AiState {
  config: AiConfig | null;
  loading: boolean;
  error: string | null;

  fetchConfig: () => Promise<void>;
  updateConfig: (config: AiConfig) => Promise<boolean>;
  fetchModels: (args: FetchModelsArgs) => Promise<AiModelInfo[]>;
  getDefaultSystemPrompt: () => Promise<string>;
}

export const useAiStore = create<AiState>((set) => ({
  config: null,
  loading: false,
  error: null,

  fetchConfig: async () => {
    set({ loading: true, error: null });
    try {
      const config = await invoke<AiConfig>("get_ai_config");
      set({ config, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  updateConfig: async (config: AiConfig) => {
    set({ loading: true, error: null });
    try {
      await invoke<boolean>("update_ai_config", { config });
      set({ config, loading: false });
      return true;
    } catch (err) {
      set({ error: String(err), loading: false });
      return false;
    }
  },

  getDefaultSystemPrompt: async () => {
    return invoke<string>("get_default_system_prompt");
  },

  fetchModels: async (args) => {
    return invoke<AiModelInfo[]>("fetch_ai_models", {
      req: {
        provider: args.provider,
        apiKey: args.api_key ?? "",
        baseUrl: args.base_url ?? null,
      },
    });
  },
}));
