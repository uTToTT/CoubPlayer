// randomizer.js — модуль случайных настроек воспроизведения для кубов.
//
// Отвечает на один вопрос: «какие настройки должны быть у ролика X?».
// Ничего не знает ни про плеер, ни про DOM — только считает значения,
// поэтому его одинаково можно использовать и для воспроизведения,
// и для превью, и для тестов.
//
// Случайность детерминированная: значение зависит только от (seed, id ролика,
// имя настройки). Из этого следуют два полезных свойства:
//   • при том же seed ролик каждый раз выглядит одинаково — можно вернуться
//     к нему кнопкой «назад» и увидеть то же самое;
//   • у каждой настройки свой поток случайных чисел, поэтому включение или
//     выключение одной галочки не перетряхивает значения остальных.

/**
 * @typedef {Object} RandomTrait
 * @property {string} key      — идентификатор, он же ключ в объекте traits
 * @property {string} label    — подпись для UI
 * @property {string} [hint]   — пояснение под подписью
 * @property {"playlist"|"playback"|"filter"|"transform"} scope — куда применяется
 * @property {string} [css]    — имя CSS-функции фильтра (для scope: "filter")
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} [suffix] — единица измерения в CSS ("deg", "px")
 */

/** Полный список того, что модуль умеет рандомизировать. */
export const RANDOM_TRAITS = [
    {
        key: "order", label: "Порядок", hint: "перемешать плейлист",
        scope: "playlist",
    },
    {
        key: "speed", label: "Скорость", hint: "0.4×–2.2×",
        scope: "playback", min: 0.4, max: 2.2,
    },
    {
        key: "saturate", label: "Насыщенность",
        scope: "filter", css: "saturate", min: 0, max: 3.2,
    },
    {
        key: "contrast", label: "Контрастность",
        scope: "filter", css: "contrast", min: 0.35, max: 2.4,
    },
    {
        key: "brightness", label: "Яркость",
        scope: "filter", css: "brightness", min: 0.45, max: 1.8,
    },
    {
        key: "hue", label: "Оттенок",
        scope: "filter", css: "hue-rotate", min: 0, max: 360, suffix: "deg",
    },
    {
        key: "sepia", label: "Сепия",
        scope: "filter", css: "sepia", min: 0, max: 1,
    },
    {
        key: "invert", label: "Инверсия",
        scope: "filter", css: "invert", min: 0, max: 1,
    },
    {
        key: "blur", label: "Размытие",
        scope: "filter", css: "blur", min: 0, max: 6, suffix: "px",
    },
    {
        key: "mirror", label: "Отражение", hint: "половина роликов зеркально",
        scope: "transform",
    },
    {
        key: "rotate", label: "Поворот", hint: "−25°…+25°",
        scope: "transform", min: -25, max: 25, suffix: "deg",
    },
];

/** Набор по умолчанию: заметно, но ещё смотрибельно. */
export const DEFAULT_MADNESS_TRAITS = {
    order: true,
    speed: true,
    saturate: true,
    contrast: true,
    brightness: true,
    hue: true,
    sepia: false,
    invert: false,
    blur: false,
    mirror: false,
    rotate: false,
};

/** Пустые настройки — то, что применяется, когда безумие выключено. */
export const NEUTRAL_SETTINGS = Object.freeze({
    speed: 1,
    filter: "",
    transform: "",
    values: Object.freeze({}),
});

/** Приводит произвольный объект к полному набору флагов (лишнее отбрасывает). */
export function normalizeTraits(traits) {
    const out = {};
    for (const trait of RANDOM_TRAITS) {
        out[trait.key] = !!(traits?.[trait.key]);
    }
    return out;
}

/** Новый случайный seed — для кнопки «перетряхнуть». */
export function rollSeed() {
    return 1 + Math.floor(Math.random() * 999998);
}

// ─── Детерминированная случайность ────────────────────────────────────────

/** FNV-1a — быстрый строковый хэш в uint32. */
function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Mulberry32 — тот же PRNG, что использует сортировка в playlist.js. */
function mulberry32(seed) {
    let s = seed >>> 0;
    return () => {
        s += 0x6d2b79f5;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    };
}

/** Одно число [0,1) для конкретной пары (ролик, настройка). */
function rollFor(seed, id, key) {
    return mulberry32(hashString(`${id}:${key}`) ^ (seed >>> 0))();
}

const lerp = (min, max, t) => min + (max - min) * t;
const round2 = (v) => Math.round(v * 100) / 100;

const TRAIT_BY_KEY = Object.fromEntries(RANDOM_TRAITS.map((t) => [t.key, t]));

/** Описание настройки по ключу — нужно UI, чтобы нарисовать нужный контрол. */
export function traitByKey(key) {
    return TRAIT_BY_KEY[key] || null;
}

/** Нейтральное значение настройки — то, при котором она ничего не меняет. */
export function neutralValue(key) {
    switch (key) {
        case "speed": return 1;
        case "saturate":
        case "contrast":
        case "brightness": return 1;
        case "mirror": return 0;
        default: return 0; // hue, sepia, invert, blur, rotate
    }
}

// ─── Сборка готовых настроек из набора значений ───────────────────────────

/**
 * Превращает набор сырых значений в то, что можно применить к элементу:
 * строку CSS filter, строку CSS transform и playbackRate. Порядок функций
 * фильтра задаётся RANDOM_TRAITS, поэтому он одинаков для всех роликов —
 * это важно для анимации кроссфейда, которая интерполирует filter.
 * @param {Record<string, number|boolean>} values
 * @returns {CoubSettings}
 */
export function composeSettings(values) {
    if (!values) return NEUTRAL_SETTINGS;

    const filters = [];
    const transforms = [];
    const used = {};
    let speed = 1;

    for (const trait of RANDOM_TRAITS) {
        if (trait.scope === "playlist") continue;
        const raw = values[trait.key];
        if (raw === undefined || raw === null) continue;

        if (trait.scope === "filter") {
            const value = round2(Number(raw));
            used[trait.key] = value;
            filters.push(`${trait.css}(${value}${trait.suffix || ""})`);
        } else if (trait.scope === "playback") {
            speed = round2(Number(raw)) || 1;
            used[trait.key] = speed;
        } else if (trait.key === "mirror") {
            const mirrored = !!raw;
            used.mirror = mirrored;
            // scaleZ(-1) визуально ничего не делает (элемент плоский), но
            // возвращает определителю матрицы знак «+». Без него зеркальный
            // scaleX(-1) переворачивает нормаль, и у грани с
            // backface-visibility: hidden (flip-режим) она может быть
            // отсечена браузером.
            if (mirrored) transforms.push("scaleX(-1) scaleZ(-1)");
        } else if (trait.scope === "transform") {
            const angle = Math.round(Number(raw));
            used[trait.key] = angle;
            transforms.push(`rotate(${angle}${trait.suffix || ""})`);
        }
    }

    return {
        speed,
        filter: filters.join(" "),
        transform: transforms.join(" "),
        values: used,
    };
}

/** Человекочитаемое описание набора значений — для подсказок в UI. */
export function describeValues(values) {
    const { values: used } = composeSettings(values);
    const parts = [];
    for (const trait of RANDOM_TRAITS) {
        if (!(trait.key in used)) continue;
        const v = used[trait.key];
        if (trait.key === "mirror") {
            if (v) parts.push("отражение");
        } else if (trait.key === "speed") {
            parts.push(`${v}×`);
        } else {
            parts.push(`${trait.label.toLowerCase()} ${v}${trait.suffix || ""}`);
        }
    }
    return parts.join(" · ");
}

// ─── Публичное API ────────────────────────────────────────────────────────

/**
 * @typedef {Object} CoubSettings
 * @property {number} speed          — playbackRate для видео и аудио
 * @property {string} filter         — готовая строка для CSS filter ("" если нечего применять)
 * @property {string} transform      — готовая строка для CSS transform ("" если нечего применять)
 * @property {Record<string, number|boolean>} values — сырые значения по настройкам
 */

/**
 * Создаёт рандомизатор под конкретный seed и набор включённых настроек.
 * @param {{seed?: number, traits?: Record<string, boolean>}} options
 */
export function createRandomizer({ seed = 1, traits = {} } = {}) {
    const enabled = normalizeTraits(traits);
    const cache = new Map();

    /** Включена ли настройка. */
    const isEnabled = (key) => !!enabled[key];

    /** Нужно ли перемешивать порядок роликов (единственная настройка уровня плейлиста). */
    const shufflesOrder = () => isEnabled("order");

    /**
     * Сырые случайные значения для ролика — только по включённым настройкам.
     * @param {string} id
     * @returns {Record<string, number|boolean>}
     */
    function valuesFor(id) {
        if (!id) return {};
        const cached = cache.get(id);
        if (cached) return cached;

        const values = {};
        for (const trait of RANDOM_TRAITS) {
            if (!enabled[trait.key] || trait.scope === "playlist") continue;
            const roll = rollFor(seed, id, trait.key);

            if (trait.key === "mirror") {
                values.mirror = roll < 0.5;
            } else if (trait.scope === "transform") {
                values[trait.key] = Math.round(lerp(trait.min, trait.max, roll));
            } else {
                values[trait.key] = round2(lerp(trait.min, trait.max, roll));
            }
        }

        cache.set(id, values);
        return values;
    }

    /**
     * Готовые настройки для ролика.
     * @param {string} id
     * @returns {CoubSettings}
     */
    function settingsFor(id) {
        return id ? composeSettings(valuesFor(id)) : NEUTRAL_SETTINGS;
    }

    /** Короткое человекочитаемое описание — для подсказки в UI. */
    function describe(id) {
        return describeValues(valuesFor(id));
    }

    return { seed, isEnabled, shufflesOrder, valuesFor, settingsFor, describe };
}
