import type { Store } from "./store.js";

const HM_GENERATION = /\/nix\/store\/[0-9a-z]{32}-home-manager-generation/;

/** HM generation of `user` in a system toplevel, read from its activation unit. */
export async function homeGeneration(store: Store, toplevel: string, user: string): Promise<string | undefined> {
  const unit = `${toplevel}/etc/systemd/system/home-manager-${user}.service`;
  // no home-manager on this host (or not for this user)
  const resolved = await store.resolve(unit).catch(() => undefined);
  if (!resolved || (await store.kind(resolved)) !== "file") return undefined;
  const text = (await store.read(unit)).toString("utf8");
  return HM_GENERATION.exec(text)?.[0];
}
