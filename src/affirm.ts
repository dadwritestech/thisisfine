/**
 * Turning a human's words into a signed lock is the one place where natural
 * language becomes a signature, so the rule is deliberately narrow: the
 * *whole* prompt must be a yes. "yes but make it blue" is a change request,
 * not consent, and it dismisses the proposal instead of locking it.
 */
const YES_HEADS = new Set([
  "y", "yes", "yep", "yeah", "yup", "ya", "ok", "okay", "k", "sure", "lock", "do", "go", "confirm", "confirmed",
  "approve", "approved", "absolutely", "correct", "👍", "✅",
  // a few non-English yeses; a bilingual "haan" is still a yes
  "ja", "si", "sí", "oui", "haan", "ha", "avunu"
]);
// Praise rides along with a yes ("y, perfect") but is never a yes on its own:
// "perfect" alone could be about the last change, not the question asked.
const YES_FILLERS = new Set(["it", "in", "them", "all", "both", "please", "ahead", "that", "this", "one", "now",
  "perfect", "great", "good", "nice", "cool", "awesome", "exactly", "lgtm", "thanks", "thank", "you", "thx"]);

function tokens(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/\uFE0F/g, "") // emoji variation selector: the two thumbs-up encodings are the same yes
    .replace(/[.,!]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function isAffirmative(prompt: string): boolean {
  if (prompt.includes("?")) return false;
  const words = tokens(prompt);
  if (words.length === 0 || words.length > 6) return false;
  if (!words.some((w) => YES_HEADS.has(w))) return false;
  return words.every((w) => YES_HEADS.has(w) || YES_FILLERS.has(w));
}

const APPROVAL = /\b(works|working|worked|perfect|lgtm|looks? (good|great|right)|that'?s (it|right)|that is right|exactly|nailed it|love it|great|awesome|nice|beautiful|ship it)\b|🎉|👌|💯/;
const DOUBT = /\b(not|no|never|still|broken|but|fail\w*|wrong|bug\w*|except|almost)\b|n't/;

/**
 * "works!" / "perfect" / "lgtm": the moment a behaviour was just confirmed.
 * Only short messages count; a long prompt that happens to contain "great"
 * is a new request, and nudging there would be noise.
 */
export function isApproval(prompt: string): boolean {
  const text = prompt.toLowerCase().trim();
  if (text.length > 60 || text.includes("?")) return false;
  return APPROVAL.test(text) && !DOUBT.test(text);
}

export type PromptClass = "machine" | "command" | "affirmative" | "approval" | "other";

/**
 * Claude Code fires UserPromptSubmit for turns it starts itself (task
 * notifications and the like arrive as `<tag>…`) and for slash commands.
 * Neither is a human answering a proposal, so both are neutral: they
 * neither lock nor dismiss.
 */
export function classifyPrompt(prompt: string): PromptClass {
  const text = prompt.trim();
  if (text.startsWith("<")) return "machine";
  if (text.startsWith("/")) return "command";
  if (isAffirmative(text)) return "affirmative";
  if (isApproval(text)) return "approval";
  return "other";
}
