# sd-forge-prompt-queue

Adds a 📥 button to the txt2img tools row (next to 📋 🗑️ 🖌️). Pick a queue JSON exported by the
Stable Pronts site and every prompt is generated in order through the real **Generate** button,
so Batch count, Hires. fix, sampler, size, etc. are all respected (Batch count 4 = each prompt 4x).

- JSON format: `{"version":1,"prompts":[{"name":"...","prompt":"...","orientation":"standing"}]}` (a plain array of strings also works).
- Optional `orientation`: `"standing"` (taller than wide) or `"lying"` (wider than tall). If the current size does not match, the ⇅ swap button is clicked to fix it. Missing/unknown values or a missing button are skipped.
- While running, the button shows progress (`3/20`); click it to stop (interrupts the current generation).
- Keep the browser tab open. Closing/reloading it drops the queue.
- Only the prompt text is replaced; the negative prompt field is left as is
  (`<NegativePrompt:...>` markers are handled by sd-forge-prompt-blacklist).

## Running in the background (Chrome)
You can switch to other tabs/windows while the queue runs, but Chrome's **Memory Saver** may freeze or
discard the inactive WebUI tab, which stops the queue. Exempt the WebUI address:

1. Open `chrome://settings/performance`.
2. Under **Always keep these sites active**, click **Add** and enter the WebUI address, e.g. `127.0.0.1`
   (or `localhost`, depending on how you open it).

While the queue runs the extension also plays an inaudible tone and falls back to timers for
`requestAnimationFrame`, so the tab keeps working in the background. If a run still stalls, call
`promptQueueDump()` in the browser console to get the full timestamped log.

## Install
Copy/symlink this folder into `stable-diffusion-webui-forge/extensions/` and restart the WebUI.
