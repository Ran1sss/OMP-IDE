import type { IdeApi } from "../shared/types";

declare global {
  interface Window {
    ide: IdeApi;
  }
}

export {};
