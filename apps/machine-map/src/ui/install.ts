/** The install commands of the join dialog (MM-211). The scripts live in `scripts/fork-install`. */
const SCRIPTS = "https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install";

export type InstallTarget = "linux" | "mac" | "windows";

export const INSTALL_TARGET_LABEL: Record<InstallTarget, string> = {
  linux: "Linux",
  mac: "Mac",
  windows: "Windows",
};

/**
 * The one-liner that installs the fork and joins with `code`. `install.sh` serves Linux and
 * macOS. Join codes hold only letters, digits and a dash, so they need no shell quoting.
 */
export function installCommand(target: InstallTarget, code: string): string {
  switch (target) {
    case "linux":
    case "mac":
      return `curl -fsSL ${SCRIPTS}/install.sh | bash -s -- --join ${code}`;
    case "windows":
      return `& ([scriptblock]::Create((irm ${SCRIPTS}/install.ps1))) -Join ${code}`;
  }
}
