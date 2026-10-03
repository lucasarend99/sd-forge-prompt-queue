# sd-forge-prompt-queue

Adds a 📥 button to the txt2img tools row (next to 📋 🗑️ 🖌️). Pick a queue JSON exported by the
Stable Pronts site and every prompt is generated in order through the real **Generate** button,
so Batch count, Hires. fix, sampler, size, etc. are all respected (Batch count 4 = each prompt 4x).

- JSON format: `{"version":1,"prompts":[{"name":"...","prompt":"..."}]}` (a plain array of strings also works).
- While running, the button shows progress (`3/20`); click it to stop (interrupts the current generation).
- Keep the browser tab open. Closing/reloading it drops the queue.
- Only the prompt text is replaced; the negative prompt field is left as is
  (`<NegativePrompt:...>` markers are handled by sd-forge-prompt-blacklist).

## Install
Copy/symlink this folder into `stable-diffusion-webui-forge/extensions/` and restart the WebUI.
