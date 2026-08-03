import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

describe('Optifeed Radar Agent Skill', () => {
  const skill = read('skills/optifeed-radar/SKILL.md');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);

  it('has portable frontmatter with only the required discovery fields', () => {
    expect(frontmatter).not.toBeNull();
    expect(parseYaml(frontmatter![1]!)).toEqual({
      name: 'optifeed-radar',
      description: expect.stringContaining('AI visibility'),
    });
  });

  it('has UI metadata with an invocation-ready default prompt', () => {
    const metadata = parseYaml(
      read('skills/optifeed-radar/agents/openai.yaml'),
    ) as {
      interface: {
        display_name: string;
        short_description: string;
        default_prompt: string;
      };
    };

    expect(metadata.interface.display_name).toBe('Optifeed Radar');
    expect(metadata.interface.short_description.length).toBeGreaterThanOrEqual(
      25,
    );
    expect(metadata.interface.short_description.length).toBeLessThanOrEqual(64);
    expect(metadata.interface.default_prompt).toContain('$optifeed-radar');
  });

  it('is included in the npm release and discoverable from the README', () => {
    const pkg = JSON.parse(read('package.json')) as { files: string[] };
    const readme = read('README.md');

    expect(pkg.files).toContain('skills');
    expect(readme).toContain('## Install the Agent Skill');
    expect(readme).toContain(
      'npx skills add optifeed/optifeed-radar --skill optifeed-radar',
    );
  });

  it('leads with the free audit and guards paid checks with consent and a cap', () => {
    expect(skill).toContain('Start with the free audit');
    expect(skill).toContain('Get explicit approval');
    expect(skill).toContain('--max-cost');
  });
});
