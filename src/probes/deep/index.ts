import type { DeepProbe } from "../t3.js";
import { alacrittyProbe } from "./alacritty.js";
import { neovimProbe } from "./neovim.js";
import { tmuxProbe } from "./tmux.js";
import { zshProbe } from "./zsh.js";

/** Built-in T3 deep probes. */
export const DEEP_PROBES: DeepProbe<any>[] = [neovimProbe, zshProbe, tmuxProbe, alacrittyProbe];
