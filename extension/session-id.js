export const GROUP_PREFIX = "Grok Browser";

export function sessionShortId(sessionId) {
  const hex = String(sessionId || "local").replace(/[^a-zA-Z0-9]/g, "");
  if (!hex || hex.toLowerCase() === "local") return "";
  return hex.slice(-6).toLowerCase();
}

export function sessionGroupTitle(sessionId) {
  const short = sessionShortId(sessionId);
  return short ? `${GROUP_PREFIX} · ${short}` : GROUP_PREFIX;
}

export function isGrokGroupTitle(title) {
  return typeof title === "string" && title.startsWith(GROUP_PREFIX);
}

const COLORS = ["cyan", "blue", "green", "yellow", "orange", "red", "pink", "purple", "grey"];

export function sessionGroupColor(sessionId) {
  if (!sessionShortId(sessionId)) return "cyan";
  let h = 0;
  const s = String(sessionId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}
