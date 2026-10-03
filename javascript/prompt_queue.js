// Prompt Queue: adds an "import list" button to the txt2img tools row.
// Picking a JSON exported by the Stable Pronts site runs every prompt through
// the real Generate button, so all UI settings (batch count, hires, ...) apply.
(function () {
    const TAB = 'txt2img';
    const IDLE_LABEL = '📥';
    const POLL_MS = 400;
    const START_TIMEOUT_MS = 15000;

    let running = false;
    let stopRequested = false;

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
            .map((item) => (typeof item === 'string' ? item : item?.prompt))
            .filter((prompt) => typeof prompt === 'string' && prompt.trim());
    }

    function setPrompt(value) {
        const textarea = gradioApp().querySelector(`#${TAB}_prompt textarea`);
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function waitForStart() {
        const deadline = Date.now() + START_TIMEOUT_MS;
        while (!isGenerating()) {
            if (Date.now() > deadline) return false;
            await sleep(POLL_MS / 2);
        }
        return true;
    }

    async function waitForFinish() {
        // Require two consecutive idle polls so a brief flicker between
        // phases (e.g. hires pass) isn't mistaken for the end.
        let idle = 0;
        while (idle < 2) {
            idle = isGenerating() ? 0 : idle + 1;
            await sleep(POLL_MS);
        }
    }

    async function runQueue(prompts, button) {
        running = true;
        stopRequested = false;
        try {
            for (let i = 0; i < prompts.length; i++) {
                if (stopRequested) break;
                button.textContent = `${i + 1}/${prompts.length}`;
                setPrompt(prompts[i]);
                await sleep(600); // let live filters (blacklist) react to the change
                el(`${TAB}_generate`).click();
                if (!(await waitForStart())) {
                    console.warn('[prompt-queue] generation did not start, aborting');
                    break;
                }
                await waitForFinish();
            }
        } finally {
            running = false;
            button.textContent = IDLE_LABEL;
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
                const prompts = parseQueue(await file.text());
                if (!prompts.length) throw new Error('Queue is empty');
                runQueue(prompts, button);
            } catch (error) {
                console.error('[prompt-queue]', error);
                button.textContent = '⚠️';
                setTimeout(() => (button.textContent = IDLE_LABEL), 2500);
            }
        });

        tools.appendChild(button);
        tools.appendChild(input);
    }

    onUiLoaded(install);
})();
