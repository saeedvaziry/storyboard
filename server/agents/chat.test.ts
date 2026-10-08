import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { scopeKey, type ChatScope } from '../../src/shared/types';
import { ChatManager } from '../chat';
import { ProjectStore } from '../projects';
import { UndoStore } from '../undo';
import { writeJson } from '../util';
import { AgentRegistry } from './registry';
import type { AgentProvider, AgentTurn } from './types';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-chat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const id = await store.create({ name: 'Test' });
  const turns: { provider: string; turn: AgentTurn }[] = [];
  const provider = (id: 'claude-code' | 'codex'): AgentProvider => ({
    id,
    label: id,
    defaultModel: id,
    models: async () => [{ id, label: id, efforts: ['medium', 'high'], defaultEffort: 'medium' }],
    status: async () => ({ ok: true, label: id }),
    async *run(turn) {
      turns.push({ provider: id, turn });
      if (turn.resume && turn.sessionId === 'missing') {
        yield { type: 'done', text: 'No conversation found', isError: true, durationMs: 0 };
        return;
      }
      yield { type: 'init', sessionId: `${id}-session` };
      if (turn.prompt.endsWith('wait'))
        await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'done', text: 'Changed it.', isError: false, durationMs: 1 };
    },
  });
  const deps = {
    store,
    agents: new AgentRegistry([provider('claude-code'), provider('codex')], 'claude-code'),
    hub: { send: () => {} },
    seams: { check: async () => [] },
    undo: new UndoStore(store),
    engine: { describe: () => 'off' },
    sfx: { describe: () => 'off' },
  } as unknown as ConstructorParameters<typeof ChatManager>[0];
  const chats = new ChatManager(deps);
  const scope = { kind: 'project' } as const;
  const settled = async (target: ChatScope = scope) => {
    for (let i = 0; i < 500 && chats.isBusy(id, scopeKey(target)); i++) await delay(5);
    assert.equal(chats.isBusy(id, scopeKey(target)), false, 'chat settled');
    return chats.thread(id, target);
  };
  return { chats, store, id, scope, turns, settled };
}

test('project and scene chats enable web research on new and resumed turns without widening file permissions', async (t) => {
  const { chats, store, id, turns, settled } = await fixture(t);
  const project = await store.get(id);
  const scene = project.scenes[0];
  const scopes: ChatScope[] = [{ kind: 'project' }, { kind: 'scene', sceneId: scene.id }];
  for (const provider of ['claude-code', 'codex']) {
    for (const scope of scopes) {
      for (const resume of [false, true]) {
        await chats.send(id, scope, { text: 'Check https://example.com before updating the video.', provider });
        await settled(scope);
        const turn = turns.at(-1)!.turn;
        assert.equal(turn.resume, resume);
        for (const tool of ['WebSearch', 'WebFetch']) {
          assert.ok(turn.tools.includes(tool), `${tool} is exposed`);
          assert.ok(turn.allow.includes(tool), `${tool} can run without prompting`);
        }
        assert.ok(!turn.tools.includes('Bash'));
        assert.ok(!turn.allow.includes('Edit'));
        assert.ok(!turn.allow.includes('Write'));
        assert.match(turn.systemPrompt, /web.*tools/i);
        assert.equal(turn.mcpServers.storyboard.headers?.['X-Storyboard-Scope'], scope.kind);
        if (scope.kind === 'scene') {
          const file = `//${scene.file.replace(/^\/+/, '')}`;
          assert.deepEqual(
            turn.allow.filter((rule) => /^(Edit|Write)\(/.test(rule)),
            [`Edit(${file})`, `Write(${file})`],
          );
          assert.ok(!turn.allow.includes('mcp__storyboard__*'));
        }
      }
    }
  }
});

test('chat routes providers, resumes only same-provider sessions and retains context when switching', async (t) => {
  const { chats, store, id, scope, turns, settled } = await fixture(t);
  await writeJson(store.internalDir(id, 'chats', '_project.json'), { scope, sessionId: 'legacy-claude-session', messages: [] });
  await chats.send(id, scope, { text: 'First' });
  await settled();
  assert.equal(turns[0].provider, 'claude-code');
  assert.equal(turns[0].turn.sessionId, 'legacy-claude-session');
  assert.equal(turns[0].turn.resume, true);
  await chats.send(id, scope, { text: 'Switch', provider: 'codex', effort: 'high' });
  await settled();
  assert.equal(turns[1].turn.resume, false);
  assert.equal(turns[1].turn.effort, 'high');
  assert.match(turns[1].turn.prompt, /previous_chat.*\nuser: First/);
  assert.equal(turns[1].turn.mcpServers.storyboard.headers?.['X-Storyboard-Files'], 'scoped');
  await chats.send(id, scope, { text: 'Continue', provider: 'codex' });
  const thread = await settled();
  assert.equal(turns[2].turn.resume, true);
  assert.equal(turns[2].turn.sessionId, 'codex-session');
  assert.equal(thread.provider, 'codex');
  assert.equal(thread.messages.at(-1)?.provider, 'codex');
  await chats.send(id, scope, { text: 'Back', provider: 'claude-code' });
  await settled();
  assert.equal(turns[3].turn.resume, false);
  assert.match(turns[3].turn.prompt, /user: Continue/);
});

test('missing sessions retry fresh and clear chat forgets the provider session', async (t) => {
  const { chats, store, id, scope, turns, settled } = await fixture(t);
  await writeJson(store.internalDir(id, 'chats', '_project.json'), {
    scope,
    provider: 'codex',
    sessionId: 'missing',
    messages: [],
  });
  await chats.send(id, scope, { text: 'Recover', provider: 'codex' });
  await settled();
  assert.deepEqual(
    turns.map((x) => x.turn.resume),
    [true, false],
  );
  await chats.clear(id, scope);
  assert.deepEqual(await chats.thread(id, scope), { scope, sessionId: null, messages: [] });
  await chats.send(id, scope, { text: 'New', provider: 'codex' });
  await settled();
  assert.equal(turns[2].turn.resume, false);
  assert.ok(!turns[2].turn.prompt.includes('previous_chat'));
});

test('concurrent sends cannot mix providers and clearing a running turn cannot resurrect its session', async (t) => {
  const { chats, id, scope, turns } = await fixture(t);
  const results = await Promise.allSettled([
    chats.send(id, scope, { text: 'wait', provider: 'codex' }),
    chats.send(id, scope, { text: 'Another', provider: 'claude-code' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  for (let i = 0; i < 500 && turns.length === 0; i++) await delay(5);
  assert.equal(turns.length, 1);
  await chats.clear(id, scope);
  assert.equal(turns[0].turn.signal.aborted, true);
  assert.deepEqual(await chats.thread(id, scope), { scope, sessionId: null, messages: [] });
});
