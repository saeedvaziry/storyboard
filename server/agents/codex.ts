import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { AgentModel } from '../../src/shared/agents';
import { CODEX_BIN, DEFAULT_CODEX_MODEL, LOCAL_DIR } from '../config';
import { AsyncQueue, type AgentEvent, type AgentProvider, type AgentProviderStatus, type AgentTurn } from './types';

const execFileAsync = promisify(execFile);
type Json = Record<string, any>;
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Use the CLI's saved login, not an API key accidentally inherited from the server.
  if (!process.env.STORYBOARD_USE_API_KEY) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  return env;
}

export async function codexStatus(bin = CODEX_BIN) {
  let version: string;
  try {
    version = (await execFileAsync(bin, ['--version'], { timeout: 15000 })).stdout.trim();
  } catch {
    return { installed: false, supported: false, loggedIn: false, version: undefined };
  }
  const env = codexEnv();
  const help = await execFileAsync(bin, ['exec', '--help'], { timeout: 15000, env }).catch(() => null);
  const supported = Boolean(help?.stdout.includes('--ignore-user-config') && help.stdout.includes('--ignore-rules'));
  try {
    await execFileAsync(bin, ['login', 'status'], { timeout: 15000, env });
    return { installed: true, supported, loggedIn: true, version };
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string };
    const loggedIn = /not logged in/i.test(`${error.stdout}\n${error.stderr}`) ? false : null;
    return { installed: true, supported, loggedIn, version };
  }
}

/** Codex maintains this account-specific catalog; never read or copy its credentials. */
export function codexModels(catalog: unknown): AgentModel[] {
  const models: AgentModel[] = [{ id: 'default', label: 'Codex default', efforts: EFFORTS, defaultEffort: 'medium' }];
  const entries = (catalog as Json | null)?.models;
  if (!Array.isArray(entries)) return models;
  for (const entry of entries) {
    if (!entry || entry.visibility !== 'list' || typeof entry.slug !== 'string' || models.some((m) => m.id === entry.slug))
      continue;
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((x: Json) => x?.effort).filter((x: unknown): x is string => typeof x === 'string')
      : EFFORTS;
    if (!efforts.length) efforts.push('medium');
    models.push({
      id: entry.slug,
      label: typeof entry.display_name === 'string' ? entry.display_name : entry.slug,
      efforts,
      defaultEffort: efforts.includes(entry.default_reasoning_level)
        ? entry.default_reasoning_level
        : efforts.includes('medium')
          ? 'medium'
          : efforts[0],
    });
  }
  return models;
}

/** Encode CLI overrides as TOML, not JSON (objects use `=` in TOML inline tables). */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`)
      .join(', ')} }`;
  }
  return JSON.stringify(value);
}

export function codexArgs(turn: AgentTurn): string[] {
  const servers = Object.fromEntries(
    Object.entries(turn.mcpServers).map(([name, server]) => [
      name,
      {
        url: server.url,
        http_headers: server.headers ?? {},
        required: true,
        // Pre-approve only this scoped MCP server, not shell commands or direct filesystem writes.
        default_tools_approval_mode: 'approve',
        startup_timeout_sec: 30,
        tool_timeout_sec: 300,
      },
    ]),
  );
  const overrides: Record<string, unknown> = {
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    model_provider: 'openai',
    model_reasoning_effort: turn.effort,
    developer_instructions: `${turn.systemPrompt}\n\nUse list_project_files, read_project_file, edit_project_file and write_project_file for project code. Discover Storyboard tools with tool_search if they are not exposed yet. Paths are relative to the project. Shell and apply_patch cannot edit files in this session; all changes go through the scoped Storyboard tools.`,
    project_doc_max_bytes: 0,
    project_root_markers: ['.storyboard-agent-root'],
    web_search: 'live',
    'agents.enabled': false,
    'skills.bundled.enabled': false,
    'skills.include_instructions': false,
    mcp_servers: servers,
  };
  for (const feature of [
    'shell_tool',
    'shell_snapshot',
    'apps',
    'plugins',
    'hooks',
    'browser_use',
    'computer_use',
    'js_repl',
    'code_mode',
    'multi_agent',
    'multi_agent_v2',
    'memories',
    'view_image',
    'skill_mcp_dependency_install',
  ]) {
    overrides[`features.${feature}`] = false;
  }
  return [
    'exec',
    ...(turn.resume ? ['resume', turn.sessionId] : []),
    // Keep every override after the subcommand; mixing -c on both sides can drop earlier values.
    ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
    ...(turn.model === 'default' ? [] : ['--model', turn.model]),
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '-',
  ];
}

/** Runs a headless Codex turn using the user's own Codex login. */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly defaultModel = DEFAULT_CODEX_MODEL;

  constructor(
    private bin = CODEX_BIN,
    private workDir = path.join(LOCAL_DIR, 'agents', 'codex'),
  ) {}

  async models(): Promise<AgentModel[]> {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const catalog = await fs.promises
      .readFile(path.join(home, 'models_cache.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    return codexModels(catalog);
  }

  async status(): Promise<AgentProviderStatus> {
    const status = await codexStatus(this.bin);
    let detail: string | undefined;
    if (!status.installed)
      detail = `Codex CLI not found (${this.bin}). Install it from https://developers.openai.com/codex/cli, then run codex login, or set CODEX_PATH.`;
    else if (!status.supported)
      detail =
        'Update Codex CLI (0.159.0 or newer recommended). Storyboard needs exec --ignore-user-config and --ignore-rules to isolate its tools.';
    else if (status.loggedIn === false) detail = 'Codex is not logged in. Run `codex login` in a terminal, then try again.';
    return {
      ok: !detail,
      label: this.label,
      version: status.version,
      detail:
        detail ?? (status.loggedIn === null ? 'Could not check the Codex login. If chat fails, run `codex login`.' : undefined),
    };
  }

  async *run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    if (turn.signal.aborted) {
      yield { type: 'done', text: 'Stopped.', isError: false, durationMs: 0, subtype: 'aborted' };
      return;
    }
    // An app-owned root prevents project .codex settings from adding tools or hooks. File access is via MCP only.
    const cwd = this.workDir;
    await fs.promises.mkdir(cwd, { recursive: true });
    await fs.promises.writeFile(path.join(cwd, '.storyboard-agent-root'), '');
    const queue = new AsyncQueue<AgentEvent>();
    const child = spawn(this.bin, codexArgs(turn), { cwd, env: codexEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const started = Date.now();
    let stderr = '';
    let closed = false;
    const parser = new CodexParser((event) => queue.push(event));
    const log = process.env.STORYBOARD_AGENT_LOG ? fs.createWriteStream(process.env.STORYBOARD_AGENT_LOG, { flags: 'a' }) : null;
    log?.on('error', () => undefined);
    child.stdin.on('error', () => undefined);
    child.stdin.end(turn.prompt);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      log?.write(`${line}\n`);
      parser.line(line);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8000);
    });
    const timers: NodeJS.Timeout[] = [];
    const onAbort = () => {
      if (closed) return;
      child.kill('SIGINT');
      timers.push(
        setTimeout(() => !closed && child.kill('SIGTERM'), 1500),
        setTimeout(() => !closed && child.kill('SIGKILL'), 5000),
      );
      timers.forEach((timer) => timer.unref());
    };
    child.once('error', (e) => {
      parser.finish(`Could not start Codex (${this.bin}): ${e.message}`, true);
    });
    child.once('close', (code) => {
      closed = true;
      turn.signal.removeEventListener('abort', onAbort);
      timers.forEach(clearTimeout);
      lines.close();
      log?.end();
      if (!parser.finished) {
        const aborted = turn.signal.aborted;
        parser.finish(
          aborted
            ? 'Stopped.'
            : stderr.trim().split('\n').slice(-6).join('\n') || `Codex exited with code ${code} before completing the turn.`,
          !aborted,
          aborted ? 'aborted' : 'crashed',
        );
      }
      queue.end();
    });
    if (turn.signal.aborted) onAbort();
    else turn.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const event of queue) {
        yield event.type === 'done' ? { ...event, durationMs: Date.now() - started } : event;
      }
    } finally {
      if (!closed) onAbort();
    }
  }
}

function resultText(result: Json | undefined): string {
  return Array.isArray(result?.content)
    ? result.content
        .map((p: Json) => (p.type === 'text' ? String(p.text ?? '') : p.type === 'image' ? '[image]' : ''))
        .filter(Boolean)
        .join('\n')
    : '';
}

/** Maps Codex exec JSONL items onto the same events as Claude Code. */
export class CodexParser {
  finished = false;
  private sessionId?: string;
  private lastText = '';
  private error = '';
  private seen = new Set<string>();
  private tools = new Set<string>();

  constructor(private emit: (event: AgentEvent) => void) {}

  finish(text: string, isError: boolean, subtype?: string) {
    if (this.finished) return;
    this.finished = true;
    if (subtype === 'crashed' && this.error) text = this.error;
    if (isError && /not logged in|unauthorized|401|refresh token|authentication/i.test(text))
      text += '\n\nRun `codex login` in a terminal, then try again.';
    this.emit({ type: 'done', text, isError, durationMs: 0, sessionId: this.sessionId, subtype });
  }

  line(raw: string) {
    if (this.finished) return;
    let event: Json;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      this.sessionId = event.thread_id;
      this.emit({ type: 'init', sessionId: event.thread_id });
    } else if (event.type === 'turn.completed') this.finish(this.lastText, false);
    else if (event.type === 'turn.failed') this.finish(event.error?.message || this.error || 'Codex turn failed.', true);
    else if (event.type === 'error') this.error = String(event.message ?? 'Codex error');
    else if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
      const item = event.item;
      if (!item || typeof item.id !== 'string' || this.seen.has(item.id)) return;
      const complete = event.type === 'item.completed';
      if (complete) this.seen.add(item.id);
      if (item.type === 'agent_message' && complete) {
        this.lastText = String(item.text ?? '');
        this.emit({ type: 'text', text: this.lastText });
      } else if (item.type === 'reasoning' && complete && item.text) this.emit({ type: 'note', text: String(item.text) });
      else if (item.type === 'mcp_tool_call') {
        if (!this.tools.has(item.id)) {
          this.tools.add(item.id);
          this.emit({
            type: 'tool-start',
            id: item.id,
            name: `mcp__${item.server}__${item.tool}`,
            input: item.arguments && typeof item.arguments === 'object' ? item.arguments : {},
          });
        }
        if (complete)
          this.emit({
            type: 'tool-end',
            id: item.id,
            isError: item.status === 'failed' || Boolean(item.error) || Boolean(item.result?.isError),
            output: item.error?.message || resultText(item.result),
          });
      } else if (item.type === 'error' && complete) this.emit({ type: 'note', text: String(item.message ?? '') });
    }
  }
}
