// Size Sync: keeps Width/Height of txt2img and img2img (which also drives the
// inpaint sub-tab) in sync in both directions. Polling is used on purpose: the
// swap (⇅) button updates the fields without firing DOM events.
(function () {
    const POLL_MS = 300;
    const PAIRS = ['width', 'height'];
    const TABS = ['txt2img', 'img2img'];

    const fields = (tab, name) => {
        const root = gradioApp().getElementById(`${tab}_${name}`);
        if (!root) return null;
        return {
            number: root.querySelector('input[type=number]'),
            range: root.querySelector('input[type=range]'),
        };
    };

    const read = (tab, name) => {
        const f = fields(tab, name);
        return f && f.number ? Number(f.number.value) : NaN;
    };

    function write(tab, name, value) {
        const f = fields(tab, name);
        if (!f || !f.number) return;
        for (const input of [f.range, f.number]) {
            if (!input) continue;
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        f.number.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function install() {
        const last = {};
        for (const name of PAIRS) {
            for (const tab of TABS) last[`${tab}_${name}`] = read(tab, name);
        }

        setInterval(() => {
            for (const name of PAIRS) {
                const [a, b] = TABS;
                const va = read(a, name);
                const vb = read(b, name);
                if (Number.isNaN(va) || Number.isNaN(vb)) continue;
                const ka = `${a}_${name}`;
                const kb = `${b}_${name}`;
                // txt2img wins if both changed in the same tick.
                if (va !== last[ka] && va !== vb) {
                    write(b, name, va);
                    last[kb] = va;
                } else if (vb !== last[kb] && vb !== va) {
                    write(a, name, vb);
                    last[ka] = vb;
                }
                last[ka] = read(a, name);
                last[kb] = read(b, name);
            }
        }, POLL_MS);
    }

    onUiLoaded(install);
})();
