import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ChatMessage, ChatScope, ChatStep, ChatThread, ProjectState, SceneState } from '../src/shared/types';
import { scopeKey } from '../src/shared/types';
import { projectSystemPrompt, projectTurnPrompt, sceneSystemPrompt, sceneTurnPrompt } from './agents/prompts';
import type { AgentProvider, AgentTurn } from './agents/types';
import type { AgentRegistry } from './agents/registry';
import { SCENE_TOOLS } from './agents/tools';
import type { MusicEngine } from './music/engine';
import { MCP_URL } from './config';
import type { Hub } from './hub';
import type { ProjectStore } from './projects';
import type { SeamService } from './seams';
import type { SfxEngine } from './sound/engine';
import type { UndoStore } from './undo';
import { HttpError, KeyedMutex, readJson, round, writeJson } from './util';

type ToolStep = Extract<ChatStep, { kind: 'tool' }>;

interface Running {
  abort: AbortController;
  done?: Promise<void>;
}

export interface SendInput {
  text: string;
  playhead?: number;
  provider?: string;
  model?: string;
  effort?: string;
}

/** Chat threads per scene (and one per project), each backed by its own agent session. */
export class ChatManager {
  private running = new Map<string, Running>();
  private sending = new KeyedMutex();

  constructor(
    private deps: {
      store: ProjectStore;
      hub: Hub;
      agents: AgentRegistry;
      seams: SeamService;
      undo: UndoStore;
      engine: MusicEngine;
      sfx: SfxEngine;
    },
  ) {}

  private file(projectId: string, key: string) {
    return this.deps.store.internalDir(projectId, 'chats', `${key}.json`);
  }

  isBusy(projectId: string, key: string) {
    return this.running.has(`${projectId}/${key}`);
  }

  async thread(projectId: string, scope: ChatScope): Promise<ChatThread> {
    return readJson<ChatThread>(this.file(projectId, scopeKey(scope)), { scope, sessionId: null, messages: [] });
  }

  private async save(projectId: string, thread: ChatThread) {
    await writeJson(this.file(projectId, scopeKey(thread.scope)), thread);
  }

  private emit(projectId: string, scope: ChatScope, message: ChatMessage) {
    this.deps.hub.send({ type: 'chat-updated', projectId, scopeKey: scopeKey(scope), message: structuredClone(message) });
  }

  send(projectId: string, scope: ChatScope, input: SendInput): Promise<ChatMessage> {
    return this.sending.run(`${projectId}/${scopeKey(scope)}`, () => this.startTurn(projectId, scope, input));
  }

  private async startTurn(projectId: string, scope: ChatScope, input: SendInput): Promise<ChatMessage> {
    const key = scopeKey(scope);
    const text = input.text.trim();
    if (!text) throw new HttpError(400, 'Message is empty');
    if (this.isBusy(projectId, key)) throw new HttpError(409, 'The agent is still working on the previous message');
    const project = await this.deps.store.get(projectId);
    if (scope.kind === 'scene' && !project.scenes.some((s) => s.id === scope.sceneId)) {
      throw new HttpError(404, `Scene "${scope.sceneId}" not found`);
    }
    const selected = await this.deps.agents.select(input);

    const thread = await this.thread(projectId, scope);
    const user: ChatMessage = { id: randomUUID(), role: 'user', text, createdAt: Date.now(), playhead: input.playhead };
    const reply: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
      steps: [],
      status: 'running',
      provider: selected.provider.id,
      model: selected.model,
    };
    thread.messages.push(user, reply);
    await this.save(projectId, thread);
    this.emit(projectId, scope, user);
    this.emit(projectId, scope, reply);

    const abort = new AbortController();
    const running: Running = { abort };
    this.running.set(`${projectId}/${key}`, running);
    this.deps.hub.send({ type: 'chat-busy', projectId, scopeKey: key, busy: true });
    running.done = this.runTurn(
      project,
      scope,
      thread,
      reply,
      { ...input, model: selected.model, effort: selected.effort },
      selected.provider,
      abort,
    )
      .catch((e: Error) => {
        reply.status = 'error';
        reply.error = e.message;
      })
      .finally(async () => {
        await this.save(projectId, thread).catch(() => undefined);
        this.running.delete(`${projectId}/${key}`);
        this.emit(projectId, scope, reply);
        this.deps.hub.send({ type: 'chat-busy', projectId, scopeKey: key, busy: false });
      });
    return reply;
  }

  stop(projectId: string, key: string) {
    this.running.get(`${projectId}/${key}`)?.abort.abort();
  }

  async clear(projectId: string, scope: ChatScope) {
    await this.sending.run(`${projectId}/${scopeKey(scope)}`, async () => {
      const running = this.running.get(`${projectId}/${scopeKey(scope)}`);
      running?.abort.abort();
      await running?.done;
      await this.save(projectId, { scope, sessionId: null, messages: [] });
      this.deps.hub.send({ type: 'chat-reset', projectId, scopeKey: scopeKey(scope) });
    });
  }

  /** Undo the most recent turn in this chat that changed files. */
  async undo(projectId: string, scope: ChatScope): Promise<ChatMessage> {
    const key = scopeKey(scope);
    if (this.isBusy(projectId, key)) throw new HttpError(409, 'Wait for the agent to finish before undoing');
    const thread = await this.thread(projectId, scope);
    const target = [...thread.messages].reverse().find((m) => m.role === 'assistant' && m.undoId && !m.undone);
    if (!target?.undoId) throw new HttpError(400, 'Nothing to undo in this chat');
    await this.deps.undo.restore(projectId, target.undoId, scope.kind === 'scene' ? scope.sceneId : undefined);
    target.undone = true;
    await this.save(projectId, thread);
    this.emit(projectId, scope, target);
    await this.deps.store.syncCode(projectId);
    this.deps.store.changed(projectId);
    void this.deps.seams.check(projectId).catch(() => undefined);
    return target;
  }

  private async runTurn(
    project: ProjectState,
    scope: ChatScope,
    thread: ChatThread,
    reply: ChatMessage,
    input: SendInput,
    provider: AgentProvider,
    abort: AbortController,
  ) {
    const { store } = this.deps;
    const scene = scope.kind === 'scene' ? project.scenes.find((s) => s.id === scope.sceneId)! : null;
    const finishUndo = await this.deps.undo.begin(project.id);
    const started = Date.now();

    let trailing = '';
    let lastEmit = 0;
    const tools = new Map<string, ToolStep>();
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 90) return;
      lastEmit = now;
      reply.text = trailing;
      this.emit(project.id, scope, reply);
    };
    const flushText = () => {
      if (trailing.trim()) reply.steps!.push({ kind: 'note', text: trailing.trim() });
      trailing = '';
      reply.text = '';
    };

    const attempt = async (resume: boolean, sessionId: string): Promise<{ retryFresh: boolean }> => {
      const turn: AgentTurn = {
        cwd: project.dir,
        prompt: scene
          ? sceneTurnPrompt(project, scene, input.text.trim(), input.playhead, this.deps.sfx.describe())
          : projectTurnPrompt(project, input.text.trim(), input.playhead, [
              this.deps.engine.describe(),
              this.deps.sfx.describe(),
            ]),
        systemPrompt: scene ? sceneSystemPrompt(project, scene) : projectSystemPrompt(project),
        sessionId,
        resume,
        model: input.model!,
        effort: input.effort!,
        tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        allow: allowRules(project, scene),
        mcpServers: {
          storyboard: {
            type: 'http',
            url: MCP_URL,
            headers: {
              'X-Storyboard-Scope': scene ? 'scene' : 'project',
              'X-Storyboard-Project': project.id,
              ...(provider.id === 'codex' ? { 'X-Storyboard-Files': 'scoped' } : {}),
              ...(scene ? { 'X-Storyboard-Scene': scene.id } : {}),
            },
          },
        },
        signal: abort.signal,
      };
      if (!resume) {
        const history = thread.messages
          .slice(0, -2)
          .filter((m) => m.text && !m.undone && m.status !== 'error')
          .slice(-20)
          .map((m) => `${m.role}: ${m.text}`)
          .join('\n\n')
          .slice(-16000);
        if (history) turn.prompt = `<previous_chat>\n${history}\n</previous_chat>\n\n${turn.prompt}`;
      }
      for await (const ev of provider.run(turn)) {
        switch (ev.type) {
          case 'init':
            thread.sessionId = ev.sessionId || sessionId;
            break;
          case 'text-delta':
          case 'text':
            trailing += `${ev.type === 'text' && trailing ? '\n\n' : ''}${ev.text}`;
            emit();
            break;
          case 'note':
            flushText();
            reply.steps!.push({ kind: 'note', text: ev.text });
            emit(true);
            break;
          case 'tool-start': {
            flushText();
            const step: ToolStep = {
              kind: 'tool',
              id: ev.id,
              name: ev.name,
              label: describeTool(ev.name, ev.input, project),
              status: 'running',
            };
            reply.steps!.push(step);
            tools.set(ev.id, step);
            emit(true);
            break;
          }
          case 'tool-end': {
            const step = tools.get(ev.id);
            if (step) {
              step.status = ev.isError ? 'error' : 'done';
              step.detail = summarizeOutput(step.name, ev.output, ev.isError);
              const images = frameUrls(ev.output);
              if (images.length) step.images = images;
            }
            emit(true);
            break;
          }
          case 'done': {
            if (
              resume &&
              ev.isError &&
              /no conversation found|(?:session|thread|rollout).*(?:not found|does not exist)|no saved.*(?:session|thread)/i.test(
                ev.text,
              )
            )
              return { retryFresh: true };
            if (ev.sessionId) thread.sessionId = ev.sessionId;
            reply.durationMs = Date.now() - started;
            reply.costUsd = ev.costUsd;
            // On errors Claude Code often streams the error as text too; show it once, as the error.
            reply.text = ev.isError
              ? ev.text.startsWith(trailing.trim())
                ? ''
                : trailing.trim()
              : (trailing.trim() || ev.text).trim();
            if (abort.signal.aborted) reply.status = 'stopped';
            else if (ev.isError) {
              reply.status = 'error';
              reply.error = ev.text || 'The agent stopped with an error';
            } else reply.status = 'done';
            break;
          }
        }
      }
      return { retryFresh: false };
    };

    try {
      const existing = (thread.provider ?? 'claude-code') === provider.id ? thread.sessionId : null;
      thread.provider = provider.id;
      thread.sessionId = existing;
      const first = await attempt(Boolean(existing), existing ?? randomUUID());
      if (first.retryFresh) {
        thread.sessionId = null;
        await attempt(false, randomUUID());
      }
    } finally {
      if (reply.status === 'running') reply.status = abort.signal.aborted ? 'stopped' : 'done';
      reply.durationMs ??= Date.now() - started;
      const undo = await finishUndo().catch(() => null);
      if (undo) {
        reply.undoId = undo.undoId;
        await store.syncCode(project.id);
        store.changed(project.id);
        void this.deps.seams.check(project.id).catch(() => undefined);
      }
    }
  }
}

function allowRules(p: ProjectState, scene: SceneState | null): string[] {
  // "//" marks an absolute path in Claude Code permission rules.
  const abs = (rel: string) => `//${path.join(p.dir, rel).replace(/^\/+/, '')}`;
  const base = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
  if (scene) {
    const file = abs(`scenes/${scene.id}.tsx`);
    return [...base, `Edit(${file})`, `Write(${file})`, ...SCENE_TOOLS.map((t) => `mcp__storyboard__${t}`)];
  }
  const writable = ['scenes/**', 'components/**', 'art-direction.md'].flatMap((rel) => [
    `Edit(${abs(rel)})`,
    `Write(${abs(rel)})`,
  ]);
  return [...base, ...writable, 'mcp__storyboard__*'];
}

const MCP_PREFIX = 'mcp__storyboard__';

function describeTool(name: string, input: Record<string, unknown>, p: ProjectState): string {
  const rel = (value: unknown) => (typeof value === 'string' ? path.relative(p.dir, value) || value : '');
  switch (name) {
    case 'Read':
      return `Read ${rel(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${rel(input.file_path)}`;
    case 'Write':
      return `Wrote ${rel(input.file_path)}`;
    case 'Glob':
      return `Listed ${String(input.pattern ?? 'files')}`;
    case 'Grep':
      return `Searched for “${String(input.pattern ?? '')}”`;
  }
  if (!name.startsWith(MCP_PREFIX)) return name;
  const tool = name.slice(MCP_PREFIX.length);
  switch (tool) {
    case 'list_project_files':
      return 'Listed project files';
    case 'read_project_file':
      return `Read ${String(input.file)}`;
    case 'write_project_file':
    case 'edit_project_file':
      return `Edited ${String(input.file)}`;
    case 'render_frames': {
      const times = Array.isArray(input.times) ? (input.times as number[]) : [];
      const at = times.map((t) => `${round(t, 2)}s`).join(', ');
      return `Rendered ${times.length} frame${times.length === 1 ? '' : 's'}${input.whole_video ? ' of the video' : ''} at ${at}`;
    }
    case 'check_seams':
      return 'Checked seams';
    case 'get_music_context':
      return 'Read the beat grid';
    case 'get_project':
      return 'Read the project structure';
    case 'set_scene_duration':
      return `Set duration to ${round(Number(input.seconds), 3)}s`;
    case 'rename_scene':
      return `Renamed scene to “${String(input.name)}”`;
    case 'create_scene':
      return `Created scene “${String(input.name)}”`;
    case 'duplicate_scene':
      return `Duplicated ${String(input.scene ?? 'scene')}`;
    case 'delete_scene':
      return `Removed ${String(input.scene ?? 'scene')}`;
    case 'move_scene':
      return `Moved ${String(input.scene ?? 'scene')} to position ${String(input.position)}`;
    case 'snap_cuts_to_music':
      return `Snapped cuts to the ${String(input.grid ?? 'bar')} grid`;
    case 'generate_music': {
      const n = Number(input.variations ?? 2);
      return `Composing ${n} music take${n === 1 ? '' : 's'}${input.bpm ? ` at ${String(input.bpm)} BPM` : ''}`;
    }
    case 'wait_for_music':
      return 'Waiting for the music';
    case 'list_music_takes':
      return 'Listed the music takes';
    case 'describe_music_take':
      return `Measured music take ${String(input.take_id)}`;
    case 'use_music_take':
      return `Switched the soundtrack to ${String(input.take_id)}`;
    case 'repaint_music':
      return `Repainting ${round(Number(input.start), 2)}–${round(Number(input.end), 2)}s of ${String(input.take_id)}`;
    case 'list_sounds':
      return 'Listed the sounds';
    case 'describe_sound':
      return `Measured the sound “${String(input.name)}”`;
    case 'create_sound': {
      const n = Number(input.variants ?? 1);
      return `Made ${n > 1 ? `${n} “${String(input.name)}” variants` : `the sound “${String(input.name)}”`} (${String(input.preset)})`;
    }
    case 'generate_sound':
      return `Generating “${String(input.name)}”: ${String(input.prompt ?? '').slice(0, 60)}`;
    case 'delete_sound':
      return `Removed the sound “${String(input.name)}”`;
    case 'check_audio':
      return input.scene ? `Checked the audio of ${String(input.scene)}` : 'Checked the audio mix';
    case 'set_music_volume':
      return `Set the music volume to ${round(Number(input.volume), 2)}`;
    default:
      return tool.replace(/_/g, ' ');
  }
}

function stripMarker(output: string): string {
  return output.replace(/\n?\[storyboard-frames:[^\]]*\]/g, '').trim();
}

function summarizeOutput(name: string, output: string, isError: boolean): string | undefined {
  const clean = stripMarker(output);
  if (isError) return clean.slice(0, 600) || 'Failed';
  const tool = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : '';
  if (tool === 'check_seams')
    return clean
      .split('\n')
      .filter((l) => l.includes('→'))
      .join('\n')
      .slice(0, 600);
  if (tool === 'render_frames' && clean.includes('ERRORS')) return clean.slice(clean.indexOf('ERRORS'), 600);
  if (tool === 'set_scene_duration' || tool === 'snap_cuts_to_music' || tool === 'use_music_take' || tool === 'set_music_volume')
    return clean.split('\n')[0];
  if (tool === 'check_audio') {
    // The loudness line, then the cues that need attention.
    const lines = clean.split('\n');
    const notable = lines.filter((l) => /→ (faint|masked|silent)|limiter −[2-9]|^- /.test(l));
    return [lines[1], ...notable].filter(Boolean).join('\n').slice(0, 600);
  }
  if (tool === 'create_sound' || tool === 'generate_sound') {
    return clean
      .split('\n')
      .filter((l) => l.startsWith('Sound "') || l.includes(' s long'))
      .join('\n')
      .slice(0, 600);
  }
  if (tool === 'generate_music' || tool === 'wait_for_music' || tool === 'repaint_music' || tool === 'describe_music_take') {
    // One line per take: its id/name and the measured tempo line.
    return clean
      .split('\n')
      .filter((l) => l.startsWith('Take ') || l.includes('BPM measured') || l.startsWith('Still composing'))
      .join('\n')
      .slice(0, 600);
  }
  return undefined;
}

function frameUrls(output: string): string[] {
  const urls: string[] = [];
  for (const match of output.matchAll(/\[storyboard-frames:([^\]]*)\]/g)) {
    urls.push(
      ...match[1]
        .trim()
        .split(/\s+/)
        .filter((u) => u.startsWith('/api/')),
    );
  }
  return urls;
}
