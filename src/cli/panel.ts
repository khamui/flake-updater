/**
 * `status --panel`, kept apart from the rest of the CLI: the XFCE panel runs
 * it every minute, so it loads only the state files and the panel text.
 */
import { access } from "node:fs/promises";
import { parseArgs } from "node:util";
import { lockHolder, onAC } from "../preflight/environment.js";
import { StateStore, defaultStateDir } from "../preflight/state.js";
import { panelMarkup } from "../report/panel.js";
import { readLastSwitch } from "../switch/rollback.js";

export const AGENT_STATE = "/var/lib/flake-agent";
export const SWITCH_STATE = "/var/lib/flake-agent-switch";

/** Is the NixOS module enabled on this system? */
export const isInstalled = () =>
  access("/etc/systemd/system/flake-agent.service").then(
    () => true,
    () => false,
  );

export async function panelMain(argv: string[], out: (text: string) => void = (t) => process.stdout.write(t)): Promise<number> {
  const { values } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: { "state-dir": { type: "string" }, "switch-state-dir": { type: "string" } } });
  const given = typeof values["state-dir"] === "string" ? values["state-dir"] : undefined;
  const installed = !given && process.getuid?.() !== 0 && (await isInstalled());
  const stateDir = installed ? AGENT_STATE : (given ?? defaultStateDir());
  const switchDir = installed ? SWITCH_STATE : typeof values["switch-state-dir"] === "string" ? values["switch-state-dir"] : undefined;
  out(
    panelMarkup(
      {
        state: await new StateStore(stateDir).load(),
        lastSwitch: switchDir ? await readLastSwitch(switchDir) : undefined,
        running: (await lockHolder(stateDir)) !== undefined,
        onAC: await onAC(),
        now: new Date(),
      },
      "alacritty --hold -e flake-agent report",
    ),
  );
  return 0;
}
