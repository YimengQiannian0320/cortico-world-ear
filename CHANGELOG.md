# Changelog

## 0.1.0

首个版本。

- 新增 `ear` World（Cortico World API 6）与 `ear_listen` 工具：按需录 2–20 秒麦克风，交给本机 Qwen2.5-Omni-3B 描述听到的声音。
- 录音走 ffmpeg `dshow` → `pipe:1`，不写临时文件（避开部分环境下 ffmpeg 写文件被拒的问题）。
- 加入 RMS 静音门：低于 `minRmsDb` 直接返回「很安静」，不调用模型，避免模型对静音编造内容。
- llama-server 按需拉起，闲置 `keepWarmMs` 后自动退出；端口已有健康服务时直接复用。
- 工具返回值附带「可能编造，只当线索」的免责说明。
