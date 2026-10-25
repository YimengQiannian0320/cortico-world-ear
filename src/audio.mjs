/**
 * 麦克风采集：用 ffmpeg 的 dshow 后端录一段，**走 stdout 管道**拿 WAV，不落盘。
 *
 * 为什么不用临时文件：在部分 Windows 环境里（尤其受控文件夹、EDR、进程沙箱），
 * ffmpeg 往某个目录写文件会被直接拒绝（`Permission denied`），而写管道没有这个问题。
 *
 * 顺带算一个响度：静音喂给音频大模型，它会编造内容（实测会说出「孩子们在玩耍」），
 * 所以必须先在本地判断“这段到底有没有声音”。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * 把配置里的命令变成可以 spawn 的东西：
 * - 空 → 用 PATH 里的同名命令；
 * - 含路径分隔符 → 文件必须在，否则返回 null；
 * - 纯名字 → 交给 PATH 解析。
 */
export function resolveTool(value, fallbackName) {
  const v = (value ?? '').trim();
  if (!v) return fallbackName;
  if (/[\\/]/.test(v)) return existsSync(v) ? v : null;
  return v;
}

/** 跑一次命令，收集 stdout(二进制) 与 stderr(文本)。 */
function run(exe, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, buffer: Buffer.alloc(0), stderr: String(e) });
      return;
    }
    const chunks = [];
    let err = '';
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, buffer: Buffer.concat(chunks), stderr: err });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } done(false); }, timeoutMs);
    child.stdout?.on('data', (d) => chunks.push(d));
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { err += String(e); done(false); });
    child.on('close', (code) => done(code === 0));
  });
}

/** 列出声卡输入设备，取第一个音频设备名；找不到返回空串。 */
export async function detectMicrophone(ffmpeg) {
  const exe = resolveTool(ffmpeg, 'ffmpeg');
  if (!exe) return '';
  const r = await run(exe, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 30_000);
  for (const line of r.stderr.split(/\r?\n/)) {
    const m = /"([^"]+)"\s*\(audio\)/.exec(line);
    if (m) return m[1];
  }
  return '';
}

/**
 * 录一段，返回 WAV 字节。
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, device?: string, error?: string }>}
 */
export async function capture(ffmpeg, mic, seconds) {
  const exe = resolveTool(ffmpeg, 'ffmpeg');
  if (!exe) return { ok: false, error: `找不到 ffmpeg：${ffmpeg}（装一个 ffmpeg 并加进 PATH，或在配置里写绝对路径）` };
  const device = mic && mic.trim() ? mic.trim() : await detectMicrophone(ffmpeg);
  if (!device) return { ok: false, error: '找不到可用的录音设备（ffmpeg -list_devices 没有列出 audio 设备）' };
  const r = await run(exe, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'dshow', '-i', `audio=${device}`,
    '-t', String(seconds),
    '-ac', '1', '-ar', '16000',
    '-f', 'wav', 'pipe:1',
  ], (seconds + 15) * 1000);
  if (!r.ok || r.buffer.length < 44) {
    return { ok: false, error: `录音失败：${(r.stderr || '').trim().slice(0, 300) || '没拿到音频数据'}` };
  }
  return { ok: true, buffer: r.buffer, device };
}

/** 解析 16 位 PCM WAV，返回 { sampleRate, channels, rmsDb, peakDb, seconds }。 */
export function analyzeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('录音输出不是 WAV');
  }
  let fmt = null;
  let data = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    at = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`不支持的 WAV 编码（format=${fmt.format}, bits=${fmt.bits}）`);
  const ch = Math.max(1, fmt.channels);
  const frames = Math.floor(data.length / (2 * ch));
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2);
    const v = s / ch / 32768;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, frames));
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);
  return {
    sampleRate: fmt.sampleRate,
    channels: ch,
    seconds: frames / (fmt.sampleRate || 16000),
    rmsDb: db(rms),
    peakDb: db(peak),
  };
}
