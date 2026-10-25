/**
 * 耳朵（Ears）：按需录一小段环境音，交给本机 Qwen2.5-Omni-3B 说出听到了什么。
 *
 * 设计取向：
 * - 只在模型主动调用时录音（用户说「听听现在」），不做常开监听，不占显存也不碰隐私；
 * - 录完先算响度，太安静就直接回「很安静」，不把静音丢给模型让它编故事
 *   （实测：静音喂给 3B，它会说「孩子们在玩耍，远处有车声」）；
 * - 结果一律标注「可能编造」，只当线索。
 */
import { capture, analyzeWav } from './audio.mjs';
import { LocalOmni } from './llama.mjs';

export const DEFAULTS = () => ({
  enabled: false,
  seconds: 5,
  /** 低于这个响度就当没声音，不调用模型。实测静音约 -54 dBFS，正常说话 -30 上下。 */
  minRmsDb: -45,
  /** 空 = 自动取第一个 dshow 录音设备；也可写死设备名，如 "麦克风 (USB Audio)"。 */
  mic: '',
  /** 空 = 用 PATH 里的 ffmpeg；也可写绝对路径。 */
  ffmpeg: '',
  /** 空 = 用 PATH 里的 llama-server；也可写绝对路径。 */
  llamaServer: '',
  /** Qwen2.5-Omni 的 GGUF 模型文件，必填。 */
  model: '',
  /** 对应的 mmproj 多模态投影器，必填。 */
  mmproj: '',
  port: 8095,
  keepWarmMs: 300000,
});

const BASE_PROMPT = '这是刚从麦克风录到的环境音。用不超过 4 句话说出你听到的声音：是什么、大概什么时候出现。'
  + '没听清或不确定就直说没听清，不要编。用中文。';

const EAR_DECL = {
  name: 'ear_listen',
  description:
    'Record a few seconds from this computer\'s microphone and have a local audio model describe what it hears. '
    + 'Use it when the user asks you to listen to the room or to what just happened ("听听现在", "你听见什么了吗"). '
    + 'It opens the microphone for that many seconds. The description is a local small model\'s guess: fine for '
    + '"someone is typing / it is raining / something fell", unreliable for naming the exact object. Never state its '
    + 'result as fact; phrase it as what you think you heard.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      seconds: { type: 'integer', minimum: 2, maximum: 20, description: 'How long to record, default 5.' },
      question: { type: 'string', description: 'Optional focus, e.g. "is there a metal sound?"' },
    },
  },
};

export class EarWorld {
  constructor(ctx) {
    this.id = 'ear';
    this.ctx = ctx;
    this.host = null;
    this.omni = null;
  }

  get cfg() {
    return this.ctx.cfg;
  }

  envPromptVars() {
    return null;
  }

  tools() {
    return [{
      ...EAR_DECL,
      handler: (args) => this.listen(args ?? {}),
    }];
  }

  async start(host) {
    this.host = host;
    this.log('耳朵就绪（按需录音）', 'info');
  }

  async stop() {
    if (this.omni) await this.omni.stop();
    this.omni = null;
  }

  log(msg, level = 'debug') {
    const fn = this.host?.log?.[level];
    if (typeof fn === 'function') fn.call(this.host.log, `[耳朵] ${msg}`);
    else if (level !== 'debug') console.log(`[耳朵] ${msg}`);
  }

  ensureOmni() {
    if (this.omni) return this.omni;
    const cfg = this.cfg;
    this.omni = new LocalOmni({
      exe: cfg.llamaServer,
      model: cfg.model,
      mmproj: cfg.mmproj,
      port: Number(cfg.port) || 8095,
      keepWarmMs: Number(cfg.keepWarmMs) || 0,
      timeoutMs: 180_000,
      log: (m) => this.log(m, 'info'),
    });
    return this.omni;
  }

  async listen(args) {
    const cfg = this.cfg;
    const seconds = Math.max(2, Math.min(20, Number(args.seconds) || Number(cfg.seconds) || 5));

    const rec = await capture(cfg.ffmpeg, cfg.mic, seconds);
    if (!rec.ok) return `[耳朵] ${rec.error}`;

    let info;
    try {
      info = analyzeWav(rec.buffer);
    } catch (e) {
      return `[耳朵] 音频读取失败：${e instanceof Error ? e.message : String(e)}`;
    }

    const minRms = Number(cfg.minRmsDb ?? -45);
    if (info.rmsDb < minRms) {
      return `[耳朵] 录了 ${seconds} 秒，环境很安静（${info.rmsDb.toFixed(1)} dBFS），没有值得描述的声音。`;
    }

    const question = typeof args.question === 'string' && args.question.trim()
      ? `\n用户特别想知道：${args.question.trim()}`
      : '';
    try {
      const text = await this.ensureOmni().ask(rec.buffer, BASE_PROMPT + question);
      if (!text) return `[耳朵] 录到了声音（${info.rmsDb.toFixed(1)} dBFS），但模型没给出描述。`;
      return `[耳朵] ${seconds} 秒录音（RMS ${info.rmsDb.toFixed(1)} dBFS，设备 ${rec.device}）：${text}\n`
        + '（这是本机 Qwen2.5-Omni-3B 的听感，可能编造细节，只能当线索，不要当成事实复述。）';
    } catch (e) {
      return `[耳朵] 识别失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

const Ear = {
  id: 'ear',
  label: '耳朵',
  defaults: DEFAULTS,
  create: (ctx) => new EarWorld(ctx),
  describe: {
    tools: [{
      name: EAR_DECL.name,
      description: EAR_DECL.description,
      tags: EAR_DECL.tags,
      parameters: EAR_DECL.parameters,
      summary: {
        zh: '录一小段麦克风，让本机小模型说听到什么（可能编，只当线索）。',
        en: 'Records a few seconds and asks a local audio model what it hears (a hint, may make things up).',
      },
    }],
    events: [],
  },
};

export default Ear;
