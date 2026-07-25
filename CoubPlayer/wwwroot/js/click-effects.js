// click-effects.js — vanilla-порт "sniper" эффекта клика (без React/gsap).

const DEFAULTS = {
    color: "#f43f5e",   // rose-500, в тон дизайн-системе плеера
    duration: 300,       // ms
    strokeWidth: 5,      // px
    effectSize: 90,      // px — радиус разлёта
    rotation: 45,         // deg
};

const LINE_ANGLES = [0, 90, 180, 270];
const DOT_ANGLES = [
    Math.PI / 3, (2 * Math.PI) / 3, (4 * Math.PI) / 3, (5 * Math.PI) / 3,
    Math.PI / 6, (5 * Math.PI) / 6, (7 * Math.PI) / 6, (11 * Math.PI) / 6,
];

let layer = null;

function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "click-fx-layer";
    document.body.appendChild(layer);
    return layer;
}

/**
 * Инициализирует эффект клика по всему документу.
 * @param {Partial<typeof DEFAULTS>} opts
 */
export function initClickEffects(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    ensureLayer();

    document.addEventListener("click", (e) => {
        spawnSniper(e.clientX, e.clientY, cfg);
    });
}

function spawnSniper(x, y, cfg) {
    const group = document.createElement("div");
    group.className = "click-fx-group";
    group.style.left = `${x}px`;
    group.style.top = `${y}px`;
    group.style.setProperty("--fx-color", cfg.color);
    group.style.setProperty("--fx-stroke", `${cfg.strokeWidth}px`);
    group.style.setProperty("--fx-duration", `${cfg.duration}ms`);
    group.style.transform = `rotate(${cfg.rotation}deg)`;

    const lineLen = cfg.effectSize * 0.2;
    const flyLen = 5 + lineLen;

    for (const angle of LINE_ANGLES) {
        const line = document.createElement("div");
        line.className = "click-fx-line";
        line.style.setProperty("--fx-angle", `${-angle}deg`);
        line.style.setProperty("--fx-line-len", `${lineLen}px`);
        line.style.setProperty("--fx-fly", `${flyLen}px`);
        group.appendChild(line);
    }

    const dist = cfg.effectSize * 0.4;
    for (const angle of DOT_ANGLES) {
        const dot = document.createElement("div");
        dot.className = "click-fx-dot";
        const tx = Math.cos(angle) * dist;
        const ty = -Math.sin(angle) * dist;
        dot.style.setProperty("--fx-tx", `${tx}px`);
        dot.style.setProperty("--fx-ty", `${ty}px`);
        group.appendChild(dot);
    }

    layer.appendChild(group);
    // Убираем DOM-узел после завершения анимации (с небольшим запасом)
    setTimeout(() => group.remove(), cfg.duration + 60);
}