export interface ThreadAvatar {
  readonly initial: string;
  readonly from: string;
  readonly to: string;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Pastel endpoints stay legible under dark initials in both themes.
export function threadAvatar(seed: string, title: string): ThreadAvatar {
  const hash = hashString(seed);
  const hue = hash % 360;
  const shift = 25 + ((hash >>> 9) % 35);
  const initial = Array.from(title.trim())[0]?.toLocaleUpperCase("ro-RO") ?? "•";
  return {
    initial: /[\p{L}\p{N}]/u.test(initial) ? initial : "•",
    from: `hsl(${hue} 80% 90%)`,
    to: `hsl(${(hue + shift) % 360} 70% 84%)`,
  };
}
