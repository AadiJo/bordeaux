import type { BordeauxAPI } from "../electron/preload";

declare global {
  interface Window {
    bordeauxAPI?: BordeauxAPI;
  }
}

export {};
