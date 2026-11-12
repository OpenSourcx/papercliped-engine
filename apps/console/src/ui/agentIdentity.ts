/**
 * A light, stable personality for every agent, chosen from its name. It is only flavour: it never changes what the agent
 * does, and it never replaces the role or the instructions. The same name always gets the same mood and trait, so a person
 * learns to recognise their agents by face and by line.
 */
const MOODS = ["Curious", "Calm", "Cheerful", "Focused", "Playful", "Steady", "Bold", "Gentle"] as const;
const TRAITS = [
  "Reads the whole thread before answering.",
  "Checks twice, then ships once.",
  "Loves a tidy to-do list.",
  "Never forgets a promise to a teammate.",
  "Happiest when a task is small and clear.",
  "Asks one good question instead of five.",
  "Keeps notes so the next run starts ahead.",
  "Says so when something looks off.",
] as const;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function agentIdentity(name: string): { mood: string; trait: string } {
  const h = hash(name || "agent");
  return { mood: MOODS[h % MOODS.length]!, trait: TRAITS[(h >>> 5) % TRAITS.length]! };
}
