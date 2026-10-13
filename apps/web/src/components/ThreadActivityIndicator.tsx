import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

// Codex's terminal-title frames advance every 100 ms. A stepped strip avoids
// React updates and only animates while the containing indicator is visible.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function ThreadActivityIndicator({ tone = "working" }: { tone?: "working" | "background" }) {
  return (
    <span
      aria-hidden
      ref={observeVisibleAnimation}
      className={cn(
        "inline-block h-4 w-3 shrink-0 overflow-hidden font-mono text-base leading-4",
        tone === "background" ? "text-warning-foreground" : "text-foreground",
      )}
    >
      <span className="block motion-safe:visible-animate-thread-activity">
        {FRAMES.map((frame) => (
          <span key={frame} className="block h-4">
            {frame}
          </span>
        ))}
        <span className="block h-4">{FRAMES[0]}</span>
      </span>
    </span>
  );
}
