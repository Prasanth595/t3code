// Forced-colors mode repaints the track and fill as Canvas, and
// appearance:auto cannot restore the native widget after the preflight
// border reset marks progress as author-styled. Use system colors instead.
export const PROGRESS_CLASS_NAME =
  "appearance-none overflow-hidden rounded-full bg-muted forced-colors:border [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary forced-colors:[&::-moz-progress-bar]:bg-[Highlight] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary forced-colors:[&::-webkit-progress-value]:bg-[Highlight]";
