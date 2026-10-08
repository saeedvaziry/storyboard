import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CODEX_BIN } from '../config';
import { handleMcp, type ToolServices } from '../mcp';
import { ProjectStore } from '../projects';
import { CodexProvider } from './codex';
import type { AgentEvent, AgentTurn } from './types';

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

// Opt in with an installed Codex CLI. All model responses and credentials are local fixtures.
test(
  'Codex CLI discovers scoped tools, edits, rejects direct writes and resumes with the same restrictions',
  {
    skip: !process.env.STORYBOARD_TEST_CODEX,
    timeout: 45000,
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-codex-integration-'));
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, t.signal, AbortSignal.timeout(35000)]);
    let server: http.Server | undefined;
    t.after(async () => {
      abort.abort();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    const store = new ProjectStore(path.join(root, 'projects'));
    const id = await store.create({ name: 'Codex integration' });
    await store.createScene(id, { name: 'Other' });
    const project = await store.get(id);
    const file = `scenes/${project.scenes[0].id}.tsx`;
    const other = project.scenes[1];
    const originalOther = await fs.readFile(other.file, 'utf8');
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    const blocked = path.join(work, 'forbidden.txt');
    await fs.mkdir(home);
    const search = (call_id: string) => ({
      type: 'tool_search_call',
      call_id,
      execution: 'client',
      arguments: { query: 'storyboard read_project_file edit_project_file', limit: 2 },
    });
    const call = (call_id: string, name: string, args: Record<string, unknown>) => ({
      type: 'function_call',
      id: `fc_${call_id}`,
      call_id,
      namespace: 'mcp__storyboard',
      name,
      arguments: JSON.stringify(args),
    });
    const message = (text: string) => ({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
    const original = 'export default function Scene';
    const firstEdit = '// First Codex edit\nexport default function Scene';
    const responses = [
      search('search_first'),
      call('read_first', 'read_project_file', { file }),
      call('edit_other', 'edit_project_file', { file: `scenes/${other.id}.tsx`, old_text: original, new_text: 'Not allowed' }),
      call('edit_first', 'edit_project_file', { file, old_text: original, new_text: firstEdit }),
      {
        type: 'custom_tool_call',
        id: 'ctc_patch',
        call_id: 'patch',
        name: 'apply_patch',
        input: `*** Begin Patch\n*** Add File: ${blocked}\n+Not allowed\n*** End Patch\n`,
      },
      message('Changed the scene.'),
      search('search_resumed'),
      call('read_resumed', 'read_project_file', { file }),
      call('edit_resumed', 'edit_project_file', { file, old_text: firstEdit, new_text: `// Resumed Codex edit\n${original}` }),
      message('Resumed successfully.'),
    ];
    const services = { store, engine: { isReady: () => false }, sfx: { isReady: () => false } } as ToolServices;
    let calls = 0;
    let failure: unknown;
    server = http.createServer(async (req, res) => {
      try {
        if (req.url === '/mcp') {
          assert.equal(req.headers['x-storyboard-scope'], 'scene');
          assert.equal(req.headers['x-storyboard-project'], id);
          assert.equal(req.headers['x-storyboard-scene'], project.scenes[0].id);
          assert.equal(req.headers['x-storyboard-files'], 'scoped');
          await handleMcp(req, res, services);
          return;
        }
        if (req.url !== '/v1/responses') {
          res.writeHead(404).end();
          return;
        }
        let raw = '';
        for await (const data of req) raw += data;
        const body = JSON.parse(raw);
        assert.equal(body.model, 'gpt-5.5');
        const tools = body.tools.map((tool: { name?: string; type: string }) => tool.name ?? tool.type);
        for (const tool of ['exec_command', 'shell', 'shell_command', 'spawn_agent', 'view_image'])
          assert.ok(!tools.includes(tool), `${tool} must remain disabled, including on resume`);
        const web = body.tools.find((tool: { type: string }) => tool.type === 'web_search');
        assert.ok(web, 'web search must be available, including on resume');
        assert.equal(web.external_web_access, true, 'web access must be live, not cached');
        assert.ok(tools.includes('tool_search'));
        if (calls === 2) assert.match(JSON.stringify(body.input), /export default function Scene/);
        if (calls === 8) assert.match(JSON.stringify(body.input), /First Codex edit/);
        const item = responses[calls++];
        assert.ok(item, 'unexpected model request');
        const response = {
          id: `resp_${calls}`,
          object: 'response',
          model: 'gpt-5.5',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const event = (type: string, data: Record<string, unknown>) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
        event('response.output_item.added', { output_index: 0, item });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response });
        res.end();
      } catch (e) {
        failure = e;
        res.writeHead(500).end(String(e));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const bin = path.join(root, 'codex');
    const modelProvider = `model_providers.storyboard_fixture={name="Local fixture",base_url="http://127.0.0.1:${port}/v1",env_key="STORYBOARD_TEST_API_KEY",wire_api="responses"}`;
    await fs.writeFile(
      bin,
      `#!/bin/sh
export CODEX_HOME=${quote(home)}
unset OPENAI_API_KEY CODEX_API_KEY
export STORYBOARD_TEST_API_KEY=not-a-real-key
exec ${quote(CODEX_BIN)} "$@" -c 'model_provider="storyboard_fixture"' -c ${quote(modelProvider)}
`,
      { mode: 0o755 },
    );
    const provider = new CodexProvider(bin, work);
    const turn: AgentTurn = {
      cwd: project.dir,
      prompt: 'Protocol test',
      systemPrompt: 'Use the Storyboard tools.',
      model: 'gpt-5.5',
      effort: 'medium',
      resume: false,
      sessionId: 'unused',
      tools: [],
      allow: [],
      signal,
      mcpServers: {
        storyboard: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: {
            'X-Storyboard-Scope': 'scene',
            'X-Storyboard-Project': id,
            'X-Storyboard-Scene': project.scenes[0].id,
            'X-Storyboard-Files': 'scoped',
          },
        },
      },
    };
    const collect = async (input: AgentTurn) => {
      const events: AgentEvent[] = [];
      for await (const event of provider.run(input)) events.push(event);
      if (failure) throw failure;
      const done = events.at(-1);
      assert.equal(done?.type, 'done');
      assert.ok(done?.type === 'done' && !done.isError, JSON.stringify(done));
      return events;
    };
    const first = await collect(turn);
    assert.equal(calls, 6);
    assert.match(await fs.readFile(project.scenes[0].file, 'utf8'), /First Codex edit/);
    assert.equal(await fs.readFile(other.file, 'utf8'), originalOther);
    await assert.rejects(fs.access(blocked), { code: 'ENOENT' });
    assert.equal(first.filter((e) => e.type === 'tool-end' && e.isError).length, 1);
    assert.equal(first.filter((e) => e.type === 'tool-end' && !e.isError).length, 2);
    const init = first.find((e) => e.type === 'init');
    assert.ok(init?.sessionId);
    const resumed = await collect({ ...turn, resume: true, sessionId: init.sessionId, prompt: 'Continue' });
    assert.equal(calls, 10);
    assert.equal(resumed.find((e) => e.type === 'init')?.sessionId, init.sessionId);
    assert.equal(resumed.filter((e) => e.type === 'tool-end' && !e.isError).length, 2);
    assert.match(await fs.readFile(project.scenes[0].file, 'utf8'), /Resumed Codex edit/);
  },
);
