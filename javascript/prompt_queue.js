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

    // ---- diagnostics -------------------------------------------------------
    // Every line is timestamped (ms since the queue started), printed to the
    // console and kept in a buffer. Run `promptQueueDump()` in the console to
    // copy the whole log, or open the 📋 dump that is printed on every abort.
    const logBuffer = [];
    let t0 = performance.now();
    const stamp = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`;
    const fmt = (args) => args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
    const push = (level, args) => {
        logBuffer.push(`${new Date().toISOString()} ${stamp()} ${level} ${fmt(args)}`);
        if (logBuffer.length > 5000) logBuffer.shift();
    };
    const log = (...args) => { push('LOG ', args); console.log('[prompt-queue]', stamp(), ...args); };
    const warn = (...args) => { push('WARN', args); console.warn('[prompt-queue]', stamp(), ...args); };
    window.promptQueueDump = () => {
        const text = logBuffer.join('\n');
        console.log(text);
        // Fails when the tab has no focus; the console dump above is enough then.
        try { navigator.clipboard?.writeText(text).catch(() => {}); } catch (e) { /* ignore */ }
        return text;
    };

    const describe = (node) => (node
        ? `display=${node.style.display || '-'} visible=${node.offsetParent !== null} disabled=${!!node.disabled} class="${node.className}"`
        : 'MISSING');
    const safe = (fn, fallback = '?') => { try { return fn(); } catch (e) { return `${fallback}(${e.message})`; } };

    // Network: count in-flight fetches to the Gradio queue and log each one.
    let inflight = 0;
    const inflightList = new Map();
    let fetchSeq = 0;
    const origFetch = window.fetch;
    if (origFetch && !window.__promptQueueFetchWrapped) {
        window.__promptQueueFetchWrapped = true;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : input?.url ?? '';
            const interesting = /queue|run|predict|internal|api|progress|call/.test(url) && !/\.(js|css|png|jpg|webp|svg|woff2?)(\?|$)/.test(url);
            if (!interesting) return origFetch.apply(this, arguments);
            const id = ++fetchSeq;
            const method = init?.method ?? 'GET';
            inflight++;
            inflightList.set(id, `${method} ${url.slice(0, 80)} @${stamp()}`);
            const noisy = /progress/.test(url);
            if (running && !noisy) log(`net#${id} -> ${method} ${url.slice(0, 120)} (inflight=${inflight})`);
            return origFetch.apply(this, arguments).then((res) => {
                inflight--; inflightList.delete(id);
                if (running && !noisy) log(`net#${id} <- ${res.status} ${url.slice(0, 80)} (inflight=${inflight})`);
                return res;
            }, (err) => {
                inflight--; inflightList.delete(id);
                if (running) warn(`net#${id} FAILED ${url.slice(0, 80)}: ${err?.message ?? err}`);
                throw err;
            });
        };
    }
    // Server-sent events used by Gradio 4 (/queue/data).
    const OrigES = window.EventSource;
    if (OrigES && !window.__promptQueueESWrapped) {
        window.__promptQueueESWrapped = true;
        window.EventSource = function (url, cfg) {
            const es = new OrigES(url, cfg);
            if (running) {
                log(`SSE open ${String(url).slice(0, 100)}`);
                es.addEventListener('error', () => warn(`SSE error ${String(url).slice(0, 80)} readyState=${es.readyState}`));
                es.addEventListener('message', (ev) => {
                    if (!running) return;
                    const msg = String(ev.data).slice(0, 160);
                    if (!/process_generating/.test(msg)) log(`SSE msg ${msg}`);
                });
            }
            return es;
        };
        window.EventSource.prototype = OrigES.prototype;
    }

    const snapshot = () => {
        const gen = el(`${TAB}_generate`);
        const interrupt = el(`${TAB}_interrupt`);
        const skip = el(`${TAB}_skip`);
        const results = el(`${TAB}_results`);
        const gallery = el(`${TAB}_gallery`);
        const parts = [
            `generate[${describe(gen)}]`,
            `interrupt[${describe(interrupt)}]`,
            `skip[${describe(skip)}]`,
            `isGenerating=${isGenerating()}`,
            `docHidden=${document.hidden}`,
            `inflight=${inflight}`,
            `galleryImgs=${safe(() => gallery.querySelectorAll('img').length)}`,
            `loadingOverlay=${safe(() => [...results.querySelectorAll('.wrap, .progress-level, .progressDiv, .eta-bar')].filter((n) => n.offsetParent !== null && !n.classList.contains('hide')).map((n) => `${n.className.toString().slice(0, 40)}:"${(n.innerText || '').replace(/\s+/g, ' ').slice(0, 60)}"`).join('|') || 'none')}`,
            `resultsClass="${safe(() => results.className.toString().slice(0, 80))}"`,
            `infoText="${safe(() => (el(`html_info_${TAB}`)?.innerText || el(`html_log_${TAB}`)?.innerText || '').replace(/\s+/g, ' ').slice(0, 120))}"`,
            `errorBox="${safe(() => [...gradioApp().querySelectorAll('.toast-wrap, .error, [class*=error]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').replace(/\s+/g, ' ').slice(0, 100)).join('|') || 'none')}"`,
            `size=${dimension('width')}x${dimension('height')}`,
            `batch=${safe(() => gradioApp().querySelector(`#${TAB}_batch_count input[type=number]`)?.value)}`,
            `mem=${safe(() => `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB`, 'n/a')}`,
        ];
        if (inflightList.size) parts.push(`pending=[${[...inflightList.values()].join('; ')}]`);
        return parts.join(' ');
    };

    // Log every visibility change of the Generate / Interrupt / Skip buttons so
    // we can see whether (and when) the UI ever flipped into "generating".
    let buttonObserver = null;
    function watchButtons() {
        unwatchButtons();
        buttonObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                const id = m.target.id || m.target.className;
                log(`DOM ${id} ${m.attributeName} changed -> ${safe(() => describe(m.target))}`);
            }
        });
        for (const name of ['generate', 'interrupt', 'skip']) {
            const node = el(`${TAB}_${name}`);
            if (node) buttonObserver.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'disabled'] });
            else warn(`cannot observe ${TAB}_${name}: MISSING`);
        }
        const results = el(`${TAB}_results`);
        if (results) buttonObserver.observe(results, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    function unwatchButtons() {
        if (buttonObserver) buttonObserver.disconnect();
        buttonObserver = null;
    }

    // Periodic full snapshot while a wait loop is blocking.
    async function heartbeat(label, everyMs, until) {
        let last = Date.now();
        return () => {
            if (Date.now() - last >= everyMs) {
                last = Date.now();
                log(`heartbeat[${label}] ${snapshot()}`);
            }
        };
    }

    // Background-tab workarounds. Chrome pauses requestAnimationFrame in hidden
    // tabs (Gradio needs it to process the Generate click) and throttles timers,
    // so while the queue runs we (1) fall back to setTimeout for rAF when the tab
    // is hidden and (2) keep an inaudible audio stream alive, which exempts the
    // tab from timer throttling.
    const REAL_RAF = window.requestAnimationFrame.bind(window);
    const REAL_CAF = window.cancelAnimationFrame.bind(window);
    const RAF_OFFSET = 1e9;
    let rafShimActive = false;
    function installRafShim() {
        if (rafShimActive) return;
        rafShimActive = true;
        window.requestAnimationFrame = (cb) => {
            if (!(running && document.hidden)) return REAL_RAF(cb);
            return RAF_OFFSET + setTimeout(() => cb(performance.now()), 16);
        };
        window.cancelAnimationFrame = (id) => {
            if (id >= RAF_OFFSET) clearTimeout(id - RAF_OFFSET);
            else REAL_CAF(id);
        };
        log('rAF fallback installed (used only while the tab is hidden)');
    }

    let keepAlive = null;
    function startKeepAlive() {
        stopKeepAlive();
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const ctx = new Ctx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0.00001; // inaudible but non-zero so the tab counts as playing audio
            osc.frequency.value = 20;
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            ctx.resume?.();
            keepAlive = { ctx, osc };
            log(`keep-alive audio started state=${ctx.state}`);
        } catch (error) {
            warn(`keep-alive audio failed: ${error?.message ?? error}`);
        }
    }
    function stopKeepAlive() {
        if (!keepAlive) return;
        try { keepAlive.osc.stop(); keepAlive.ctx.close(); } catch (error) { /* ignore */ }
        keepAlive = null;
        log('keep-alive audio stopped');
    }

    const onWindowError = (e) => warn(`window error: ${e.message} @ ${e.filename}:${e.lineno}`);
    const onRejection = (e) => warn(`unhandled rejection: ${e.reason?.message ?? e.reason}`);
    const onVisibility = () => log(`visibilitychange hidden=${document.hidden}`);

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
        const began = Date.now();
        const deadline = began + START_TIMEOUT_MS;
        const beat = await heartbeat('start', 5000);
        log(`waiting for generation to start (timeout ${START_TIMEOUT_MS}ms) ${snapshot()}`);
        while (!isGenerating()) {
            if (Date.now() > deadline) {
                warn(`start timeout after ${Date.now() - began}ms ${snapshot()}`);
                return false;
            }
            beat();
            await sleep(POLL_MS / 2);
        }
        log(`generation started after ${Date.now() - began}ms ${snapshot()}`);
        return true;
    }

    async function waitForFinish() {
        // Require two consecutive idle polls so a brief flicker between
        // phases (e.g. hires pass) isn't mistaken for the end.
        const began = Date.now();
        const beat = await heartbeat('finish', 10000);
        log(`waiting for generation to finish ${snapshot()}`);
        let idle = 0;
        let flickers = 0;
        while (idle < 2) {
            const busy = isGenerating();
            if (busy && idle > 0) { flickers++; log(`flicker: idle=${idle} then busy again (#${flickers})`); }
            idle = busy ? 0 : idle + 1;
            beat();
            await sleep(POLL_MS);
        }
        log(`generation finished after ${Date.now() - began}ms, flickers=${flickers} ${snapshot()}`);
    }

    async function runQueue(prompts, button, meta, startAt = 0) {
        t0 = performance.now();
        logBuffer.length = 0;
        running = true;
        stopRequested = false;
        log(`starting queue "${meta.name}" with ${prompts.length} prompts from ${startAt + 1}; UA=${navigator.userAgent}`);
        log(`initial state ${snapshot()}`);
        watchButtons();
        installRafShim();
        startKeepAlive();
        window.addEventListener('error', onWindowError);
        window.addEventListener('unhandledrejection', onRejection);
        document.addEventListener('visibilitychange', onVisibility);
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
                log(`=== item ${i + 1}/${prompts.length} begin ${snapshot()}`);
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
                    log(`step 4: click dispatched, state right after: ${snapshot()}`);
                    await sleep(250);
                    log(`step 4: state 250ms after click: ${snapshot()}`);
                    started = await waitForStart();
                    if (!started) warn(`generation did not start (attempt ${attempt}/${START_ATTEMPTS}) at ${i + 1}/${prompts.length} ${snapshot()}`);
                }
                if (stopRequested) break;
                if (!started) {
                    abortReason = `generation never started at ${i + 1}/${prompts.length} after ${START_ATTEMPTS} attempts x ${START_TIMEOUT_MS / 1000}s (Generate click ignored or still queued by the UI)`;
                    warn(`giving up: ${abortReason}`);
                    warn(`final state ${snapshot()}`);
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
            log(`queue ended (aborted=${aborted} stop=${stopRequested}) ${snapshot()}`);
            unwatchButtons();
            stopKeepAlive();
            window.removeEventListener('error', onWindowError);
            window.removeEventListener('unhandledrejection', onRejection);
            document.removeEventListener('visibilitychange', onVisibility);
            running = false;
            if (aborted) {
                console.log('[prompt-queue] full log below (also copied to clipboard; rerun with promptQueueDump())');
                window.promptQueueDump();
            }
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
