// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * ci.yml and publish.yml run the same suite, so they must prepare the runner the same way. The preparation lives
 * once, as composite actions under `.github/actions/`; a workflow that copies the steps inline instead of using the
 * action, or leaves them out, drifts from the other (publish.yml once lacked plugin-hostd and failed a tag at
 * src/pins-file.test.ts, #84). This test reads both workflows as text and fails on that drift, and on an action
 * that no longer sets the variables the suite asks for.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const SHARED = ['build-native', 'install-plugin-hostd'] as const;
const WORKFLOWS = ['ci.yml', 'publish.yml'] as const;

/** The `uses:` lines of a workflow, in order, and the index of the step that runs the suite. */
function usesOf(workflow: string): string[] {
  return [...read(`.github/workflows/${workflow}`).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
}

function indexOfLine(text: string, needle: RegExp): number {
  return text.split('\n').findIndex((line) => needle.test(line));
}

describe('ci.yml and publish.yml prepare the runner alike', () => {
  for (const workflow of WORKFLOWS) {
    const text = read(`.github/workflows/${workflow}`);
    for (const action of SHARED) {
      it(`${workflow} uses the shared ${action} action, once, before it lints`, () => {
        const uses = usesOf(workflow).filter((u) => u === `./.github/actions/${action}`);
        expect(uses).toHaveLength(1);
        const at = indexOfLine(text, new RegExp(`uses: \\./\\.github/actions/${action}$`));
        const lint = indexOfLine(text, /^\s*(run:\s*)?pnpm lint\s*$/);
        expect(at).toBeGreaterThan(-1);
        expect(lint).toBeGreaterThan(at);
      });
    }

    it(`${workflow} carries no inline copy of the shared steps`, () => {
      expect(text).not.toMatch(/apt-get install[^\n]*plugin-hostd/);
      expect(text).not.toMatch(/make -C native deps/);
      expect(text).not.toMatch(/PLUGIN_HOSTD/);
    });
  }

  it('the install action sets what src/pins-file.test.ts asks for and checks the floor', () => {
    const action = read('.github/actions/install-plugin-hostd/action.yml');
    expect(action).toMatch(/>> "\$GITHUB_ENV"/);
    for (const variable of ['PLUGIN_HOSTD', 'PLUGIN_HOSTD_FAKE_HOST']) {
      expect(action).toContain(`echo "${variable}=`);
    }
    expect(action).toMatch(/dpkg --compare-versions .* ge 0\.2\.0/);
  });

  it('publish.yml publishes by OIDC: no token, no secret', () => {
    const text = read('.github/workflows/publish.yml');
    expect(text).toMatch(/id-token:\s*write/);
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  });
});
