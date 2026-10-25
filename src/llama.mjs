/**
 * 本机 llama-server 的生命周期：按需拉起、健康检查、空闲回收，以及把一段 WAV 交给
 * Qwen2.5-Omni 听。进程只在用到时存在，闲置 keepWarmMs 后自杀，避免白占显存。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveTool } from './audio.mjs';

const HEALTH_POLL_MS = 1000;

export class LocalOmni {
  constructor(opts) {
    this.opts = opts;
    this.proc = null;
    this.starting = null;
    this.idleTimer = null;
    this.log = opts.log ?? (() => {});
  }

  get base() {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  /** 端口上已经有一个健康的服务（比如用户自己开的），直接复用。 */
  async healthy() {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return false;
      const j = await r.json();
      return j?.status === 'ok';
    } catch {
      return false;
    }
  }

  /** 确保服务可用；首次调用会拉起进程并等到模型加载完。 */
  async ensure() {
    if (await this.healthy()) return true;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { model, mmproj, port } = this.opts;
      const exe = resolveTool(this.opts.exe, 'llama-server');
      if (!exe) throw new Error(`找不到 llama-server：${this.opts.exe}（装一个并加进 PATH，或在配置里写绝对路径）`);
      for (const [name, p] of [['模型', model], ['mmproj', mmproj]]) {
        if (!p || !existsSync(p)) throw new Error(`${name} 不存在：${p || '(未配置)'}`);
      }
      this.log(`启动 llama-server（端口 ${port}）`);
      this.proc = spawn(exe, [
        '-m', model,
        '--mmproj', mmproj,
        '-ngl', '99',
        '-c', '2048',
        '--host', '127.0.0.1',
        '--port', String(port),
      ], { windowsHide: true, stdio: 'ignore' });
      this.proc.on('exit', () => { this.proc = null; });

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (await this.healthy()) return true;
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
      }
      throw new Error('llama-server 180 秒内没有起来（看是不是显存不够或模型路径不对）');
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** 用一段 WAV 问一句，返回模型文字。 */
  async ask(wav, prompt) {
    await this.ensure();
    const b64 = Buffer.from(wav).toString('base64');
    const body = {
      model: 'local',
      temperature: 0,
      max_tokens: 220,
      frequency_penalty: 0.4,
      presence_penalty: 0.3,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'input_audio', input_audio: { data: b64, format: 'wav' } },
        ],
      }],
    };
    const r = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 180_000),
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`llama-server ${r.status}: ${raw.slice(0, 300)}`);
    const j = JSON.parse(raw);
    const content = j?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
      : String(content ?? '');
    this.touch();
    return text.trim();
  }

  /** 每次用完重置空闲计时；到点还没人用就杀掉，把显存还回去。 */
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const keep = this.opts.keepWarmMs ?? 0;
    if (!keep) return;
    this.idleTimer = setTimeout(() => { void this.stop(); }, keep);
    this.idleTimer.unref?.();
  }

  async stop() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const p = this.proc;
    this.proc = null;
    if (p && !p.killed) {
      try { p.kill(); } catch { /* ignore */ }
    }
  }
}
