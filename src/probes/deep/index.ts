import type { DeepProbe } from "../t3.js";
import { neovimProbe } from "./neovim.js";

/** Built-in T3 deep probes. */
export const DEEP_PROBES: DeepProbe<any>[] = [neovimProbe];
