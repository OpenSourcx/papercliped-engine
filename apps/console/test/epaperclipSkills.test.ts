import { describe, expect, it } from "vitest";
import { EPAPERCLIP_SKILLS } from "../src/data/epaperclipSkills.ts";

describe("skills made for ePaperclip", () => {
  it("have unique slugs, a SKILL.md header that matches, and no secrets", () => {
    const slugs = EPAPERCLIP_SKILLS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of EPAPERCLIP_SKILLS) {
      expect(s.markdown.startsWith(`---\nname: ${s.slug}\n`)).toBe(true);
      expect(s.tagline.length).toBeLessThanOrEqual(120);
      expect(/(password|api[_ -]?key|token)\s*[:=]\s*\S{8,}/i.test(s.markdown)).toBe(false);
    }
  });
});
