import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { OptionShareLot } from "../types";

interface OptionShareLotState {
  shareLots: OptionShareLot[];
  loading: boolean;
  error: string | null;

  fetchShareLots: () => Promise<void>;
  addShareLot: (stockCode: string, sharesPerContract: number) => Promise<OptionShareLot>;
  deleteShareLot: (id: number) => Promise<void>;
}

export const useOptionShareLotStore = create<OptionShareLotState>((set) => ({
  shareLots: [],
  loading: false,
  error: null,

  fetchShareLots: async () => {
    set({ loading: true, error: null });
    try {
      const shareLots = await invoke<OptionShareLot[]>("get_option_share_lots");
      set({ shareLots, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  addShareLot: async (stockCode: string, sharesPerContract: number) => {
    const lot = await invoke<OptionShareLot>("add_option_share_lot", {
      stockCode,
      sharesPerContract,
    });
    set((state) => {
      const existing = state.shareLots.findIndex((s) => s.stock_code === lot.stock_code);
      if (existing >= 0) {
        const updated = [...state.shareLots];
        updated[existing] = lot;
        return { shareLots: updated };
      }
      return { shareLots: [lot, ...state.shareLots] };
    });
    return lot;
  },

  deleteShareLot: async (id: number) => {
    await invoke("delete_option_share_lot", { id });
    set((state) => ({ shareLots: state.shareLots.filter((s) => s.id !== id) }));
  },
}));
