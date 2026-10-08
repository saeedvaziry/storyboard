import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { CLAUDE_BIN, DEFAULT_CLAUDE_MODEL, EFFORTS } from '../config';
import { AsyncQueue, type AgentEvent, type AgentProvider, type AgentProviderStatus, type AgentTurn } from './types';

const execFileAsync = promisify(execFile);

type Json = Record<string, any>;

/**
 * Runs turns through the locally installed Claude Code CLI in headless mode (`claude -p`,
 * stream-json), so they use the user's own Claude Code login.
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  readonly defaultModel = DEFAULT_CLAUDE_MODEL;
  private cached: AgentProviderStatus | null = null;

  async models() {
    return [
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-fable-5-1', 'Fable 5.1'],
    ].map(([id, label]) => ({ id, label, efforts: EFFORTS, defaultEffort: 'medium' }));
  }

  async status(): Promise<AgentProviderStatus> {
    if (this.cached?.ok) return this.cached;
    try {
      const { stdout } = await execFileAsync(CLAUDE_BIN, ['--version'], { timeout: 15000 });
      this.cached = { ok: true, label: this.label, version: stdout.trim() };
    } catch (e) {
      this.cached = {
        ok: false,
        label: this.label,
        detail: `Could not run "${CLAUDE_BIN} --version". Install Claude Code and log in, or set CLAUDE_PATH. (${(e as Error).message})`,
      };
    }
    return this.cached;
  }

  run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      turn.model,
      '--effort',
      turn.effort,
      // Explicit tools (including web research), file tools confined to the project folder, no permission bypass.
      '--restricted',
      '--tools',
      turn.tools.join(','),
      // Only the pre-approved rules below run; anything else is denied instead of prompting.
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--allowedTools',
      ...turn.allow,
      '--mcp-config',
      JSON.stringify({ mcpServers: turn.mcpServers }),
      '--strict-mcp-config',
      '--append-system-prompt',
      turn.systemPrompt,
      ...(turn.resume ? ['--resume', turn.sessionId] : ['--session-id', turn.sessionId]),
    ];

    // Music tools can wait ~100 s for the engine; allow tool calls up to 5 minutes.
    const env: NodeJS.ProcessEnv = { ...process.env, MAX_MCP_OUTPUT_TOKENS: '120000', MCP_TOOL_TIMEOUT: '300000' };
    // Use the Claude Code login (subscription) unless the user explicitly opts into an API key.
    if (!process.env.STORYBOARD_USE_API_KEY) delete env.ANTHROPIC_API_KEY;

    const child = spawn(CLAUDE_BIN, args, { cwd: turn.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined);
    child.stdin.end(turn.prompt);

    let stderr = '';
    let finished = false;
    const started = Date.now();
    const parser = new StreamJsonParser((event) => {
      if (event.type === 'done') finished = true;
      queue.push(event);
    });
    // STORYBOARD_AGENT_LOG=/path/file.jsonl records the raw stream for debugging.
    const log = process.env.STORYBOARD_AGENT_LOG ? fs.createWriteStream(process.env.STORYBOARD_AGENT_LOG, { flags: 'a' }) : null;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      log?.write(`${line}\n`);
      parser.line(line);
    });
    child.on('close', () => log?.end());
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });

    const onAbort = () => {
      child.kill('SIGINT');
      setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), 1500).unref();
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
    };
    if (turn.signal.aborted) onAbort();
    else turn.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      queue.push({
        type: 'done',
        text: `Could not start Claude Code (${CLAUDE_BIN}): ${e.message}`,
        isError: true,
        durationMs: 0,
      });
      queue.end();
    });
    child.on('close', (code) => {
      turn.signal.removeEventListener('abort', onAbort);
      if (!finished) {
        const aborted = turn.signal.aborted;
        queue.push({
          type: 'done',
          text: aborted ? 'Stopped.' : stderr.trim().split('\n').slice(-6).join('\n') || `Claude Code exited with code ${code}`,
          isError: !aborted,
          durationMs: Date.now() - started,
          subtype: aborted ? 'aborted' : 'crashed',
        });
      }
      queue.end();
    });
    return queue;
  }
}

/** Claude Code's login errors, plus how to fix them for this setup. */
function explainAuthError(text: string): string {
  if (!/not logged in|please run \/login|invalid.*(token|api key)|oauth token/i.test(text)) return text;
  const fix = 'Run `claude` in a terminal and use /login, then try again.';
  return `${text}\n\n${fix}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: Json) => (part?.type === 'text' ? String(part.text ?? '') : part?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Maps Claude Code's stream-json lines onto AgentEvents. */
class StreamJsonParser {
  private streamed = new Set<string>();
  private messageId: string | null = null;
  private blocks = new Map<number, { type: string; text: string }>();

  constructor(private emit: (e: AgentEvent) => void) {}

  line(raw: string) {
    if (!raw.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.parent_tool_use_id) return; // sub-agent traffic
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.emit({ type: 'init', sessionId: msg.session_id, model: msg.model });
        break;
      case 'stream_event':
        this.streamEvent(msg.event ?? {});
        break;
      case 'assistant':
        this.assistant(msg.message ?? {});
        break;
      case 'user':
        this.user(msg.message ?? {});
        break;
      case 'result': {
        const text = typeof msg.result === 'string' ? msg.result : '';
        this.emit({
          type: 'done',
          text: msg.is_error ? explainAuthError(text) : text,
          isError: Boolean(msg.is_error),
          durationMs: Number(msg.duration_ms) || 0,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
          sessionId: msg.session_id,
          subtype: msg.subtype,
        });
        break;
      }
    }
  }

  private streamEvent(ev: Json) {
    switch (ev.type) {
      case 'message_start':
        this.messageId = ev.message?.id ?? null;
        this.blocks.clear();
        break;
      case 'content_block_start':
        this.blocks.set(ev.index, { type: ev.content_block?.type ?? 'unknown', text: '' });
        break;
      case 'content_block_delta': {
        const block = this.blocks.get(ev.index);
        if (ev.delta?.type === 'text_delta') {
          if (this.messageId) this.streamed.add(this.messageId);
          this.emit({ type: 'text-delta', text: String(ev.delta.text ?? '') });
        } else if (ev.delta?.type === 'thinking_delta' && block) {
          block.text += String(ev.delta.thinking ?? '');
        }
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(ev.index);
        if (block?.type === 'thinking' && block.text.trim()) {
          if (this.messageId) this.streamed.add(`${this.messageId}:thinking`);
          this.emit({ type: 'note', text: block.text.trim() });
        }
        break;
      }
    }
  }

  private assistant(message: Json) {
    const id = message.id as string | undefined;
    for (const block of (message.content ?? []) as Json[]) {
      if (block.type === 'tool_use') {
        this.emit({ type: 'tool-start', id: block.id, name: block.name, input: block.input ?? {} });
      } else if (block.type === 'text' && block.text && !(id && this.streamed.has(id))) {
        this.emit({ type: 'text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking?.trim() && !(id && this.streamed.has(`${id}:thinking`))) {
        this.emit({ type: 'note', text: block.thinking.trim() });
      }
    }
  }

  private user(message: Json) {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content as Json[]) {
      if (block.type !== 'tool_result') continue;
      this.emit({
        type: 'tool-end',
        id: block.tool_use_id,
        isError: Boolean(block.is_error),
        output: toolResultText(block.content),
      });
    }
  }
}
