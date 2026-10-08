import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codexArgs, codexModels, CodexParser, CodexProvider } from './codex';
import type { AgentEvent, AgentTurn } from './types';

const turn = (overrides: Partial<AgentTurn> = {}): AgentTurn => ({
  cwd: '/project',
  prompt: 'Make a change',
  systemPrompt: 'Scene guide\nUse "quotes".',
  sessionId: 'a-session',
  resume: false,
  model: 'gpt-test',
  effort: 'high',
  tools: [],
  allow: [],
  mcpServers: {
    storyboard: {
      type: 'http',
      url: 'http://127.0.0.1:5199/mcp',
      headers: {
        'X-Storyboard-Scope': 'scene',
        'X-Storyboard-Project': 'example',
        'X-Storyboard-Scene': 'intro',
        'X-Storyboard-Files': 'scoped',
      },
    },
  },
  signal: new AbortController().signal,
  ...overrides,
});

function parse(events: unknown[]) {
  const out: AgentEvent[] = [];
  const parser = new CodexParser((e) => out.push(e));
  parser.line('not json');
  parser.line('null');
  for (const event of events) parser.line(JSON.stringify(event));
  return out;
}

test('Codex arguments isolate tools, scope MCP calls, encode TOML and resume only the supplied session', () => {
  const args = codexArgs(turn());
  assert.equal(args[0], 'exec');
  for (const value of [
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    'sandbox_mode="read-only"',
    'approval_policy="never"',
    'features.shell_tool=false',
    'features.hooks=false',
    'features.multi_agent=false',
    'web_search="live"',
    'project_doc_max_bytes=0',
  ])
    assert.ok(args.includes(value), value);
  assert.ok(!args.some((x) => x.includes('dangerously')));
  const mcp = args.find((x) => x.startsWith('mcp_servers='))!;
  assert.match(mcp, /"http_headers" = \{ "X-Storyboard-Scope" = "scene"/);
  assert.match(mcp, /"required" = true/);
  assert.match(mcp, /"default_tools_approval_mode" = "approve"/);
  assert.match(
    args.find((x) => x.startsWith('developer_instructions='))!,
    /tool_search/,
  );
  assert.match(mcp, /"tool_timeout_sec" = 300/);
  assert.equal(args.at(-1), '-');
  assert.ok(!args.includes('a-session'));
  assert.deepEqual(codexArgs(turn({ resume: true })).slice(0, 3), ['exec', 'resume', 'a-session']);
  assert.ok(codexArgs(turn({ resume: true })).includes('web_search="live"'));
  assert.ok(!codexArgs(turn({ model: 'default' })).includes('--model'));
});

test('Codex parser reports session, reasoning, MCP tools and frame markers without duplicating completed items', () => {
  const tool = { id: 't', type: 'mcp_tool_call', server: 'storyboard', tool: 'render_frames', arguments: { times: [0] } };
  const message = { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Done.' } };
  const events = parse([
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'Checking.' } },
    { type: 'item.started', item: tool },
    { type: 'item.updated', item: tool },
    {
      type: 'item.completed',
      item: {
        ...tool,
        status: 'completed',
        result: {
          content: [
            { type: 'text', text: '[storyboard-frames: /api/frame.jpg]' },
            { type: 'image', data: 'large-data' },
          ],
        },
      },
    },
    message,
    message,
    { type: 'turn.completed', usage: {} },
    { type: 'turn.completed' },
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['init', 'note', 'tool-start', 'tool-end', 'text', 'done'],
  );
  assert.deepEqual(events[2], { type: 'tool-start', id: 't', name: 'mcp__storyboard__render_frames', input: { times: [0] } });
  assert.match((events[3] as Extract<AgentEvent, { type: 'tool-end' }>).output, /storyboard-frames.*\n\[image\]/);
  assert.deepEqual(events.at(-1), {
    type: 'done',
    text: 'Done.',
    isError: false,
    durationMs: 0,
    sessionId: 'thread-1',
    subtype: undefined,
  });
});

test('Codex parser handles tool failures and authentication errors without treating retry notices as completion', () => {
  const events = parse([
    { type: 'error', message: 'Reconnecting 1/5' },
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 't',
        server: 'storyboard',
        tool: 'read_project_file',
        status: 'failed',
        error: { message: 'Denied' },
      },
    },
    { type: 'turn.failed', error: { message: '401 Unauthorized' } },
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool-start', 'tool-end', 'done'],
  );
  assert.equal((events[1] as Extract<AgentEvent, { type: 'tool-end' }>).isError, true);
  const done = events[2] as Extract<AgentEvent, { type: 'done' }>;
  assert.equal(done.isError, true);
  assert.match(done.text, /codex login/);
});

test('Codex models use the local visible catalog and each model’s effort levels, with a default fallback', () => {
  assert.equal(codexModels(null)[0].id, 'default');
  const models = codexModels({
    models: [
      {
        slug: 'gpt-new',
        display_name: 'New model',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }],
        default_reasoning_level: 'high',
      },
      { slug: 'hidden', visibility: 'hide' },
      null,
      {},
    ],
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['default', 'gpt-new'],
  );
  assert.deepEqual(models[1].efforts, ['high', 'max']);
  assert.equal(models[1].defaultEffort, 'high');
});

test('Codex process streams stdin, resumes, reports crashes and stops only its own child', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-codex-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'codex');
  await fs.writeFile(
    bin,
    `#!${process.execPath}
let prompt = '';
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
  if (prompt === 'crash') { process.stderr.write('fixture crashed'); process.exit(2); }
  const emit = e => console.log(JSON.stringify(e));
  emit({type:'thread.started', thread_id:'fixture-session'});
  if (prompt === 'wait') { setInterval(() => {}, 1000); return; }
  emit({type:'item.completed', item:{id:'m', type:'agent_message', text:JSON.stringify({prompt, args:process.argv.slice(2)})}});
  emit({type:'turn.completed'});
});
`,
    { mode: 0o755 },
  );
  const provider = new CodexProvider(bin, path.join(dir, 'work'));
  const collect = async (input: AgentTurn) => {
    const events: AgentEvent[] = [];
    for await (const e of provider.run(input)) events.push(e);
    return events;
  };
  const events = await collect(turn({ prompt: 'Hello', resume: true }));
  const text = events.find((e) => e.type === 'text')! as Extract<AgentEvent, { type: 'text' }>;
  assert.equal(JSON.parse(text.text).prompt, 'Hello');
  assert.deepEqual(JSON.parse(text.text).args.slice(0, 3), ['exec', 'resume', 'a-session']);
  assert.equal(JSON.parse(text.text).args.at(-1), '-');
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  const crash = (await collect(turn({ prompt: 'crash' }))).at(-1)! as Extract<AgentEvent, { type: 'done' }>;
  assert.equal(crash.isError, true);
  assert.match(crash.text, /fixture crashed/);
  const abort = new AbortController();
  const stopped: AgentEvent[] = [];
  for await (const e of provider.run(turn({ prompt: 'wait', signal: abort.signal }))) {
    stopped.push(e);
    if (e.type === 'init') abort.abort();
  }
  assert.equal((stopped.at(-1) as Extract<AgentEvent, { type: 'done' }>).subtype, 'aborted');
  assert.equal((await collect(turn({ signal: AbortSignal.abort() }))).length, 1);
});
