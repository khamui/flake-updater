import { describe, expect, it } from "vitest";
import { upstreamFindings, upstreamNotes } from "../../src/report/upstream.js";

const AT = "2026-11-25T03:00:00.000Z";

describe("upstream-only ids", () => {
  it("come from kind and subject plus the run's month, not the detail", () => {
    expect(upstreamFindings(["- binary-removed system/logoutd: shadow-4.19.4", "- package-removed light: 1.2.2"], AT)).toEqual([
      { id: "upstream-binary-removed-system-logoutd-2026-11", finding: "binary-removed system/logoutd: shadow-4.19.4" },
      { id: "upstream-package-removed-light-2026-11", finding: "package-removed light: 1.2.2" },
    ]);
  });

  it("are the same for the same findings of the same run", () => {
    const lines = ["- nvim-lsp-missing typescript: ts_ls", "- tmux-prefix-changed tmux: C-b → C-a"];
    expect(upstreamFindings(lines, AT)).toEqual(upstreamFindings([...lines], AT));
  });

  it("number findings sharing kind and subject", () => {
    const ids = upstreamFindings(["- zsh-startup-stderr zsh: one", "- zsh-startup-stderr zsh: two", "- zsh-startup-stderr zsh: three"], AT).map((f) => f.id);
    expect(ids).toEqual(["upstream-zsh-startup-stderr-zsh-2026-11", "upstream-zsh-startup-stderr-zsh-2026-11-2", "upstream-zsh-startup-stderr-zsh-2026-11-3"]);
  });

  it("keep subjects with spaces or a colon readable and short", () => {
    const [a, b] = upstreamFindings(["- validator-warning home:kha/.config/git/config: x", `- nvim-keymap n <leader>${"f".repeat(80)}: gone`], AT);
    expect(a!.id).toBe("upstream-validator-warning-home-kha-.config-git-config-2026-11");
    expect(b!.id.length).toBeLessThanOrEqual("upstream--2026-11".length + 60);
    expect(b!.id).toMatch(/^upstream-nvim-keymap-n-leader-f+-2026-11$/);
  });

  it("notes say what changed and in which run", () => {
    const [f] = upstreamFindings(["- binary-removed system/logoutd: shadow-4.19.4"], AT);
    const notes = upstreamNotes(f!, { at: AT, branch: "agent/update-2026-11-25", updatedInputs: ["nixpkgs"] });
    expect(notes).toContain("# upstream-binary-removed-system-logoutd-2026-11");
    expect(notes).toContain("Finding: binary-removed system/logoutd: shadow-4.19.4");
    expect(notes).toContain("Run: agent/update-2026-11-25 (2026-11-25), inputs: nixpkgs");
    expect(notes).not.toContain("```");
  });

  it("include a generated file's diff", () => {
    const [f] = upstreamFindings(["- file-changed home:kha/.config/foo.conf"], AT);
    expect(f!.id).toBe("upstream-file-changed-home-kha-.config-foo.conf-2026-11");
    const notes = upstreamNotes(f!, { at: AT }, "-a = 1\n+a = 2\n");
    expect(notes).toContain("```diff\n-a = 1\n+a = 2\n```");
  });
});
