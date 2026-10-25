# cortico-world-ear · 耳朵

给 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion)（Cortico World API 6）的一个「按需听觉」扩展：
**录一小段麦克风，交给本机跑的 Qwen2.5-Omni-3B，说出听到了什么。**

不是语音转文字。ASR 只认人声，键盘声、雨声、东西掉地上在它眼里全是噪声；
这个扩展把整段音频当成「一段声音」去理解，所以它能说「外面在下雨」「有人在敲键盘」「有东西掉地上了」。

> 纯本地推理：音频不出机器，不需要 API Key。

---

## 为什么值得单独做一个扩展

Coopanion 自带的耳朵是 ASR（SenseVoice）。我拿它和音频大模型做过对照：

| | ASR（语音转文字） | 本扩展（音频理解） |
|---|---|---|
| 有人说话 | ✅ 转成文字 | ⚠️ 也能转，但不是强项 |
| 键盘声 / 雨声 | ❌ 当成噪声丢掉 | ✅ 能描述出来 |
| 「刚才是不是有东西掉了」 | ❌ 完全答不了 | ⚠️ 能听出「有撞击」，但说不准是什么物件 |

所以两者是互补的，不是替代关系。

## 特性

- **按需录音**：只有模型调用 `ear_listen` 时才打开麦克风，不做常开监听
- **静音门**：录完先算 RMS，低于阈值直接回「很安静」，**不把静音丢给模型**
  （不加这道门，静音会让模型编出「孩子们在玩耍、远处有车声」）
- **不落盘**：ffmpeg 通过 `-f wav pipe:1` 把音频吐到 stdout，全程不写临时文件
  （在部分 Windows 环境下 ffmpeg 写文件会被拒绝，实测 `Permission denied`）
- **进程按需启停**：llama-server 在第一次用到时才拉起，闲置 `keepWarmMs` 后自动退出，把显存还回去
- **不伪造确定性**：工具返回值里明确标注「这是本机小模型的听感，可能编造，只当线索」

## 依赖

| 组件 | 说明 |
|---|---|
| Windows | 录音走 ffmpeg 的 `dshow` 后端，目前只支持 Windows |
| [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) | 需要带 `dshow` 支持的 Windows 构建 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | 需要带 `llama-server` 的构建（Vulkan / CUDA 都可以） |
| [Qwen2.5-Omni-3B GGUF](https://huggingface.co/ggml-org/Qwen2.5-Omni-3B-GGUF) | `Qwen2.5-Omni-3B-Q4_K_M.gguf` + `mmproj-Qwen2.5-Omni-3B-Q8_0.gguf` |

两个模型文件合计约 3.5 GB，Q4 量化在 8 GB 显存的卡上就能跑。

## 安装

1. 把本包放到 Coopanion 的扩展目录：

   ```
   <Coopanion>\data\extensions\node_modules\cortico-world-ear\
   ```

2. 在 `<Coopanion>\data\extensions\package.json` 的 `dependencies` 里登记：

   ```json
   { "cortico-world-ear": "0.1.0" }
   ```

3. 在 `<Coopanion>\data\home\companion\config.json` 的 `worlds` 里加配置（见下），
   然后**完全退出并重启** Coopanion。

## 配置

```json
"worlds": {
  "ear": {
    "enabled": true,
    "seconds": 5,
    "minRmsDb": -45,
    "mic": "",
    "ffmpeg": "D:/tools/ffmpeg/bin/ffmpeg.exe",
    "llamaServer": "D:/tools/llama.cpp/llama-server.exe",
    "model": "D:/models/Qwen2.5-Omni-3B-Q4_K_M.gguf",
    "mmproj": "D:/models/mmproj-Qwen2.5-Omni-3B-Q8_0.gguf",
    "port": 8095,
    "keepWarmMs": 300000
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否挂载本 World |
| `seconds` | `5` | 默认录音秒数；工具调用时可覆盖（2–20） |
| `minRmsDb` | `-45` | 静音门。静音实测约 `-54`，正常说话约 `-30`；调低更敏感，调高更保守 |
| `mic` | `""` | 空 = 自动取第一个 dshow 录音设备；也可写死，如 `"麦克风 (USB Audio)"` |
| `ffmpeg` | `""` | 空 = 用 PATH 里的 `ffmpeg`；也可写绝对路径 |
| `llamaServer` | `""` | 空 = 用 PATH 里的 `llama-server`；也可写绝对路径 |
| `model` / `mmproj` | `""` | **必填**，Qwen2.5-Omni 的 GGUF 与多模态投影器 |
| `port` | `8095` | llama-server 端口；端口上已有健康服务时直接复用 |
| `keepWarmMs` | `300000` | 用完闲置多久关掉服务，`0` = 一直留着 |

## 工具

模型可用 `ear_listen(seconds?, question?)`，典型触发是用户说「听听现在」「你听见什么了吗」。

返回示例：

```
安静时：
[耳朵] 录了 5 秒，环境很安静（-62.6 dBFS），没有值得描述的声音。

有声时：
[耳朵] 5 秒录音（RMS -28.3 dBFS，设备 麦克风 (USB Audio)）：雨声、键盘敲击声。
（这是本机 Qwen2.5-Omni-3B 的听感，可能编造细节，只能当线索，不要当成事实复述。）
```

## 实测能力（Qwen2.5-Omni-3B Q4_K_M，RX 6800 + Vulkan）

| 素材 | 结果 |
|---|---|
| 18 秒：雨声 + 键盘 | ✅ 说出「雨声」「电脑键盘的敲击声」，问「有没有东西掉落」时正确否认，**零误报** |
| 8 秒：环境底噪 + 扔空易拉罐 | ⚠️ 听见两次撞击，但材质说成「玻璃瓶」；时间范围报到 38 秒（实际 8 秒） |
| 4 秒纯静音 | ❌ 原始模型会编「孩子们在玩耍、远处有车声」——**这就是静音门存在的原因** |

耗时：18 秒音频约 3.7–4.4 秒返回；首次调用要等模型加载 5–10 秒。

顺带测过的反例：**Voxtral Mini 3B 不适合这个场景**——它是语音模型，让它描述环境声时要么拒答
（`I'm unable to listen...`），要么把键盘雨声硬转成英文幻觉词。

## 已知限制

- **物件级识别不可靠**：能分「有没有撞击」，分不清「易拉罐还是玻璃瓶」。
- **时间轴不可信**：模型报的秒数经常离谱，别拿来做对齐。
- **会补声音**：安静环境、单一音源时可能虚构出并不存在的声音，所以工具返回值带免责声明。
- **只支持 Windows**（dshow 录音）。
- 每次调用都会占用几秒麦克风，不做常开监听是刻意的取舍。

## 卸载

1. `worlds.ear.enabled` 改成 `false`（保留配置），或整段删掉；
2. 彻底移除：从 `data/extensions/package.json` 删掉依赖项，再删除本包目录。

## License

MIT
