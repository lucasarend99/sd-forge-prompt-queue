// Prompt Queue: adds an "import list" button to the txt2img tools row.
// Picking a JSON exported by the Stable Pronts site runs every prompt through
// the real Generate button, so all UI settings (batch count, hires, ...) apply.
(function () {
    const TAB = 'txt2img';
    const IDLE_LABEL = '📥';
    const POLL_MS = 400;
    const START_TIMEOUT_MS = 90000;
    const START_ATTEMPTS = 2;

    const STORAGE_PREFIX = 'prompt-queue:';
    const PROGRESS_TTL_MS = 24 * 60 * 60 * 1000;

    let running = false;
    let stopRequested = false;

    const log = (...args) => console.log('[prompt-queue]', ...args);
    const warn = (...args) => console.warn('[prompt-queue]', ...args);
    const snapshot = () => {
        const gen = el(`${TAB}_generate`);
        const interrupt = el(`${TAB}_interrupt`);
        const skip = el(`${TAB}_skip`);
        const describe = (node) => (node
            ? `display=${node.style.display || '-'} visible=${node.offsetParent !== null} disabled=${!!node.disabled}`
            : 'MISSING');
        return `generate[${describe(gen)}] interrupt[${describe(interrupt)}] skip[${describe(skip)}] isGenerating=${isGenerating()}`;
    };

    // Progress is kept per file name so an aborted queue can resume where it
    // stopped. Entries older than 24h are purged. Storage may be unavailable
    // (private window, blocked site data), so every access is guarded.
    const progressKey = (name) => STORAGE_PREFIX + name;
    function loadProgress(name, total, size) {
        try {
            const saved = JSON.parse(localStorage.getItem(progressKey(name)));
            const fresh = saved && Date.now() - saved.savedAt < PROGRESS_TTL_MS;
            if (fresh && saved.total === total && saved.size === size && saved.next > 0 && saved.next < total) return saved.next;
        } catch (error) { /* ignore */ }
        return 0;
    }
    function saveProgress(name, next, total, size) {
        try {
            localStorage.setItem(progressKey(name), JSON.stringify({ next, total, size, savedAt: Date.now() }));
        } catch (error) { /* ignore */ }
    }
    function clearProgress(name) {
        try { localStorage.removeItem(progressKey(name)); } catch (error) { /* ignore */ }
    }
    function purgeOldProgress() {
        try {
            for (const key of Object.keys(localStorage)) {
                if (!key.startsWith(STORAGE_PREFIX)) continue;
                let savedAt = 0;
                try { savedAt = JSON.parse(localStorage.getItem(key))?.savedAt ?? 0; } catch (error) { /* corrupt entry */ }
                if (Date.now() - savedAt >= PROGRESS_TTL_MS) localStorage.removeItem(key);
            }
        } catch (error) { /* ignore */ }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const el = (id) => gradioApp().getElementById(id);
    const isGenerating = () => {
        const interrupt = el(`${TAB}_interrupt`);
        return !!interrupt && interrupt.style.display !== 'none' && interrupt.offsetParent !== null;
    };

    function parseQueue(text) {
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : data.prompts;
        if (!Array.isArray(list)) {
            throw new Error('Invalid queue file');
        }
        return list
            .map((item) => (typeof item === 'string'
                ? { prompt: item }
                : { prompt: item?.prompt, orientation: item?.orientation }))
            .filter((item) => typeof item.prompt === 'string' && item.prompt.trim());
    }

    const dimension = (name) => {
        const input = gradioApp().querySelector(`#${TAB}_${name} input[type=number]`);
        return input ? Number(input.value) : NaN;
    };

    // "standing" = taller than wide, "lying" = wider than tall. Clicks the
    // swap (⇅) button until the size matches; silently skips if the button or
    // size fields can't be found, or the orientation is missing/unknown.
    async function applyOrientation(orientation) {
        if (orientation !== 'standing' && orientation !== 'lying') return;
        const matches = () => {
            const w = dimension('width');
            const h = dimension('height');
            if (Number.isNaN(w) || Number.isNaN(h) || w === h) return true; // unknown or square: nothing to do
            return orientation === 'standing' ? h > w : w > h;
        };
        const swap = el(`${TAB}_res_switch_btn`);
        if (!swap) {
            warn('swap button not found, skipping orientation');
            return;
        }
        for (let attempt = 0; attempt < 2 && !matches(); attempt++) {
            log(`orientation=${orientation}, size=${dimension('width')}x${dimension('height')}, clicking swap (try ${attempt + 1})`);
            swap.click();
            await sleep(300);
        }
        log(`orientation applied, size=${dimension('width')}x${dimension('height')}`);
    }

    function setPrompt(value) {
        const textarea = gradioApp().querySelector(`#${TAB}_prompt textarea`);
        if (!textarea) throw new Error('prompt textarea not found');
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function waitForStart() {
        const deadline = Date.now() + START_TIMEOUT_MS;
        log(`waiting for generation to start (timeout ${START_TIMEOUT_MS}ms)`);
        while (!isGenerating()) {
            if (Date.now() > deadline) return false;
            await sleep(POLL_MS / 2);
        }
        log('generation started');
        return true;
    }

    async function waitForFinish() {
        // Require two consecutive idle polls so a brief flicker between
        // phases (e.g. hires pass) isn't mistaken for the end.
        log('waiting for generation to finish');
        let idle = 0;
        while (idle < 2) {
            idle = isGenerating() ? 0 : idle + 1;
            await sleep(POLL_MS);
        }
        log('generation finished');
    }

    async function runQueue(prompts, button, meta, startAt = 0) {
        log(`starting queue with ${prompts.length} prompts from ${startAt + 1}`);
        running = true;
        stopRequested = false;
        // Tag errors raised by other scripts (e.g. Gradio) while the queue runs.
        const originalError = console.error;
        console.error = (...args) => {
            if (running) originalError.call(console, '[prompt-queue] error from page during queue:', ...args);
            else originalError.apply(console, args);
        };
        let aborted = false;
        let abortReason = '';
        try {
            for (let i = startAt; i < prompts.length; i++) {
                if (stopRequested) break;
                saveProgress(meta.name, i, prompts.length, meta.size);
                button.textContent = `${i + 1}/${prompts.length}`;
                log(`--- ${i + 1}/${prompts.length} orientation=${prompts[i].orientation ?? '-'} size=${dimension('width')}x${dimension('height')}`);
                log(`step 1: setting prompt (${prompts[i].prompt.length} chars): ${prompts[i].prompt.slice(0, 80)}`);
                setPrompt(prompts[i].prompt);
                log('step 2: applying orientation');
                await applyOrientation(prompts[i].orientation);
                log('step 3: waiting 600ms for live filters');
                await sleep(600); // let live filters (blacklist) react to the change
                let started = false;
                for (let attempt = 1; attempt <= START_ATTEMPTS && !started && !stopRequested; attempt++) {
                    const generate = el(`${TAB}_generate`);
                    log(`step 4: clicking generate (attempt ${attempt}/${START_ATTEMPTS}) ${snapshot()}`);
                    if (!generate) throw new Error('generate button not found');
                    generate.click();
                    started = await waitForStart();
                    if (!started) warn(`generation did not start (attempt ${attempt}/${START_ATTEMPTS}) at ${i + 1}/${prompts.length} ${snapshot()}`);
                }
                if (stopRequested) break;
                if (!started) {
                    abortReason = `generation never started at ${i + 1}/${prompts.length} after ${START_ATTEMPTS} attempts x ${START_TIMEOUT_MS / 1000}s (Generate click ignored or still queued by the UI)`;
                    warn(`giving up: ${abortReason}`);
                    aborted = true;
                    break;
                }
                log('step 5: generation running');
                await waitForFinish();
                log(`step 6: item ${i + 1}/${prompts.length} done`);
                saveProgress(meta.name, i + 1, prompts.length, meta.size);
            }
            if (!stopRequested && !aborted) clearProgress(meta.name);
            log(`${stopRequested ? 'stopped by user' : aborted ? `aborted: ${abortReason}` : 'done'}`);
        } catch (error) {
            aborted = true;
            abortReason = `crashed: ${error?.message ?? error}`;
            console.error('[prompt-queue] queue crashed', error);
        } finally {
            console.error = originalError;
            running = false;
            button.textContent = aborted ? '⚠️' : IDLE_LABEL;
            if (aborted) {
                button.title = `Queue aborted: ${abortReason}`;
                setTimeout(() => (button.textContent = IDLE_LABEL), 5000);
            }
        }
    }

    function install() {
        const tools = el(`${TAB}_tools`);
        if (!tools || el(`${TAB}_prompt_queue`)) return;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';

        const button = document.createElement('button');
        button.id = `${TAB}_prompt_queue`;
        button.className = 'lg secondary gradio-button tool svelte-cmf5ev';
        button.type = 'button';
        button.textContent = IDLE_LABEL;
        button.title = 'Import prompt list (JSON) and generate all of them. Click again while running to stop.';

        button.addEventListener('click', () => {
            if (running) {
                stopRequested = true;
                el(`${TAB}_interrupt`)?.click();
                return;
            }
            if (isGenerating()) return;
            input.click();
        });

        input.addEventListener('change', async () => {
            const file = input.files[0];
            input.value = '';
            if (!file) return;
            try {
                log(`file selected: ${file.name} (${file.size} bytes)`);
                const prompts = parseQueue(await file.text());
                log(`parsed ${prompts.length} prompts`);
                if (!prompts.length) throw new Error('Queue is empty');
                const meta = { name: file.name, size: file.size };
                let startAt = loadProgress(meta.name, prompts.length, meta.size);
                if (startAt && !confirm(`"${file.name}" stopped at ${startAt + 1}/${prompts.length}.\n\nOK = continue from ${startAt + 1}\nCancel = start over`)) {
                    startAt = 0;
                }
                runQueue(prompts, button, meta, startAt);
            } catch (error) {
                console.error('[prompt-queue]', error);
                button.textContent = '⚠️';
                setTimeout(() => (button.textContent = IDLE_LABEL), 2500);
            }
        });

        tools.appendChild(button);
        tools.appendChild(input);
    }

    purgeOldProgress();
    onUiLoaded(install);
})();
