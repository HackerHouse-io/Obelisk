import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_ROOT = join(__dirname, '..', '..', 'skills');

const REQUIRED_SKILLS = ['ios-simulator-control', 'appium-driving', 'ios-evidence-capture'];

const REQUIRED_SECTIONS = ['## Capabilities', '## Worked example', '## Troubleshooting'];

describe('iOS QA Pilot skills', () => {
  for (const name of REQUIRED_SKILLS) {
    const skillPath = join(SKILL_ROOT, name, 'SKILL.md');

    it(`${name}: SKILL.md exists`, () => {
      expect(existsSync(skillPath)).toBe(true);
    });

    it(`${name}: contains all required sections`, () => {
      const text = readFileSync(skillPath, 'utf8');
      for (const section of REQUIRED_SECTIONS) {
        expect(text, `${name} missing section ${section}`).toContain(section);
      }
    });

    it(`${name}: front-matter declares the skill name`, () => {
      const text = readFileSync(skillPath, 'utf8');
      const match = /^---\s*\n([\s\S]*?)\n---/.exec(text);
      expect(match, `${name} has no frontmatter`).not.toBeNull();
      expect(match![1]!).toMatch(new RegExp(`name:\\s*${name}`));
    });
  }
});
