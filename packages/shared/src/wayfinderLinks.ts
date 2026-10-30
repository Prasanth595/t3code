const validId = (value: string) =>
  value.length > 0 &&
  value.length <= 512 &&
  value !== "." &&
  value !== ".." &&
  [...value].every((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127);

export function isWayfinderLink(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "wayfinder:" || url.username || url.password || url.port || url.hash)
      return false;
    const kind = url.hostname;
    if (kind !== "repo" && kind !== "map" && kind !== "ticket" && kind !== "prototype")
      return false;
    if (kind === "map" && (url.pathname === "" || url.pathname === "/")) {
      const repo = url.searchParams.get("repo") ?? "";
      const number = url.searchParams.get("number") ?? "";
      return (
        [...url.searchParams.keys()].every((key) => key === "repo" || key === "number") &&
        url.searchParams.getAll("repo").length === 1 &&
        url.searchParams.getAll("number").length === 1 &&
        /^[\w.-]+\/[\w.-]+$/.test(repo) &&
        repo.split("/").every((part) => part !== "." && part !== "..") &&
        /^[1-9]\d*$/.test(number) &&
        Number.isSafeInteger(Number(number))
      );
    }
    const parts = url.pathname.split("/");
    if (parts.length !== 2 || !validId(decodeURIComponent(parts[1] ?? ""))) return false;
    if (kind !== "prototype") return url.search.length === 0;
    const allowed = new Set(["canvas", "rev", "page", "item"]);
    if (
      [...url.searchParams.keys()].some(
        (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
      )
    )
      return false;
    const canvas = url.searchParams.get("canvas") ?? "";
    const revision = url.searchParams.get("rev");
    return (
      canvas.length <= 2048 &&
      canvas.startsWith("prototypes/") &&
      /\.html?$/i.test(canvas) &&
      canvas.split("/").every((part) => validId(part) && !/[\\?#%:]/.test(part)) &&
      (revision === null || /^[a-f0-9]{40}$/i.test(revision)) &&
      ["page", "item"].every(
        (key) => !url.searchParams.has(key) || validId(url.searchParams.get(key) ?? ""),
      )
    );
  } catch {
    return false;
  }
}
