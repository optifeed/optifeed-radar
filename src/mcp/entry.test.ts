import { describe, expect, it } from 'vitest';
import { mcpContextInput } from './entry.js';

describe('MCP entry context', () => {
  it('anchors state on the real home directory, not $HOME', () => {
    // Windows sets USERPROFILE, not HOME. Reading env.HOME there falls through
    // to cwd - which for a desktop-client-launched server is arbitrary (often
    // the client install dir), the exact scattering this design avoids.
    const input = mcpContextInput({
      env: {},
      cwd: () => 'C:\\Windows\\System32',
      homedir: () => 'C:\\Users\\erdem',
    });
    expect(input.homeDir).toBe('C:\\Users\\erdem');
  });

  it('prefers the real home over a conflicting HOME value', () => {
    const input = mcpContextInput({
      env: { HOME: '/stale/home' },
      cwd: () => '/',
      homedir: () => '/Users/erdem',
    });
    expect(input.homeDir).toBe('/Users/erdem');
  });

  it('keeps writing under home rather than cwd (the documented choice)', () => {
    const input = mcpContextInput({
      env: {},
      cwd: () => '/some/project',
      homedir: () => '/Users/erdem',
    });
    expect(input.isProjectWritable).toBe(false);
    expect(input.cwd).toBe('/some/project');
  });
});
