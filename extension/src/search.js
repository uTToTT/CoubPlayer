// search.js — копия wwwroot/js/search.js из плеера, слово в слово.
//
// Расширение не может импортировать модули плеера: content script
// подключается классическим скриптом и живёт на чужой странице. Поэтому
// файл именно копируется, а не переписывается заново — правки вносятся
// в плеере и переносятся сюда целиком.
//
// Наружу отдаётся один объект: content script берёт CPD_SEARCH.filterByQuery.

(() => {
"use strict";
// search.js — сопоставление запроса со строкой для всех полей поиска плеера.
//
// Раньше везде стояло toLowerCase().includes(q), и это промахивалось на трёх
// очень частых вещах:
//
//   1. Забыли переключить раскладку. «фтшьу» — это «anime», набранное русскими
//      клавишами. Раскладку сопоставляем по положению клавиш, а не по звучанию:
//      это точное соответствие, а не догадка.
//
//   2. Одно и то же написано двумя алфавитами: плейлист называется «Аниме»,
//      а ищут «anime». Приводим обе стороны к латинице по одной таблице —
//      совпадут и «аниме», и «anime», и «Anime».
//
//   3. Опечатка. «анмие» вместо «аниме» — перестановка двух букв, и обычный
//      includes не находит ничего. Допуск считается от длины слова: в слове
//      из трёх букв одна ошибка меняет его до неузнаваемости, в слове из
//      десяти — нет.
//
// Порядок работы — от дешёвого к дорогому. Сперва подстрока по всем написаниям
// запроса (это простые операции над строками, их не жалко звать на восьми
// тысячах роликов), и только если так не нашлось почти ничего, включается
// разбор опечаток. На длинных списках иначе тормозило бы на каждой букве.
//
// Результат не «да/нет», а оценка: точное совпадение должно стоять выше
// совпадения серединой слова, а найденное по опечатке — ниже всего.

// ─── Раскладка ────────────────────────────────────────────────────────────
// Клавиша к клавише: qwerty ↔ йцукен. Строки одной длины и соответствуют
// позиционно — ряд за рядом, как на самой клавиатуре.

const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_KEYS = "йцукенгшщзхъфывапролджэячсмитьбюё";

const TO_RU = new Map([...EN_KEYS].map((ch, i) => [ch, RU_KEYS[i]]));
const TO_EN = new Map([...RU_KEYS].map((ch, i) => [ch, EN_KEYS[i]]));

/** Текст, набранный не в той раскладке, — в обе стороны сразу. */
function swapLayout(text) {
    let ru = "";
    let en = "";
    let changed = false;

    for (const ch of text) {
        const asRu = TO_RU.get(ch);
        const asEn = TO_EN.get(ch);
        if (asRu || asEn) changed = true;
        ru += asRu || ch;
        en += asEn || ch;
    }

    return changed ? [ru, en] : [];
}

// ─── Единое написание ─────────────────────────────────────────────────────

const TRANSLIT = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
    р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch",
    ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

// Одно и то же можно записать латиницей по-разному: «Kharkov» и «Harkov»,
// «shchi» и «schi». Сводим варианты к одному виду — по обе стороны сравнения,
// поэтому какой именно выбран, значения не имеет
const EQUIVALENT = [
    [/shch/g, "sch"],
    [/kh/g, "h"],
    [/ph/g, "f"],
    [/ck/g, "k"],
    [/ts/g, "c"],
];

/**
 * Приведение к сравнимому виду: регистр, ё, диакритика, лишние пробелы.
 * Дальше этой строкой и сравниваем — сырую не трогаем нигде.
 */
function fold(text) {
    return String(text ?? "")
        .toLowerCase()
        .replace(/ё/g, "е")
        // NFD разносит букву и знак над ней, второе выкидываем: «é» станет «e»
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** То же, но одним алфавитом: кириллица переписывается латиницей. */
function latin(folded) {
    let out = "";
    for (const ch of folded) out += TRANSLIT[ch] ?? ch;
    for (const [from, to] of EQUIVALENT) out = out.replace(from, to);
    return out;
}

// Оба написания строки, посчитанные один раз. Список может быть на восемь
// тысяч роликов, а печатают в поле по букве — пересчитывать на каждое
// нажатие незачем.
const KEYS = new Map();
const KEYS_LIMIT = 20000;

function keysOf(text) {
    let keys = KEYS.get(text);
    if (keys) return keys;

    const folded = fold(text);
    keys = { folded, latin: latin(folded) };

    // Кэш обслуживает открытый список; сменился плейлист — прежние строки
    // больше не нужны, и проще начать заново, чем считать обращения
    if (KEYS.size >= KEYS_LIMIT) KEYS.clear();
    KEYS.set(text, keys);
    return keys;
}

// ─── Опечатки ─────────────────────────────────────────────────────────────

/**
 * Расстояние Дамерау — Левенштейна с потолком: считаем, пока не стало ясно,
 * что дальше порога, и выходим. Перестановка соседних букв считается одной
 * ошибкой, а не двумя, — при быстром наборе это самая частая из них.
 */
function withinDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    if (a === b) return true;

    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const row = new Array(b.length + 1);
        row[0] = i;
        let best = i;

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);

            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                value = Math.min(value, prev2[j - 2] + 1);
            }

            row[j] = value;
            if (value < best) best = value;
        }

        // Вся строка хуже порога — ниже он уже не опустится
        if (best > max) return false;

        prev2 = prev;
        prev = row;
    }

    return prev[b.length] <= max;
}

/**
 * Сколько ошибок прощаем слову такой длины. В коротком слове одна ошибка —
 * это уже другое слово («кот» и «кит»), поэтому до четырёх букв не прощаем
 * ничего: иначе в выдачу полезет всё подряд.
 */
function allowance(length) {
    if (length < 4) return 0;
    if (length < 7) return 1;
    return 2;
}

// ─── Оценка совпадения ────────────────────────────────────────────────────

const SCORE = {
    EXACT: 100,
    PREFIX: 80,
    WORD: 65,
    INSIDE: 45,
    FUZZY: 20,
};

/** Насколько хорошо запрос лёг на строку. 0 — не совпало. */
function scoreIn(haystack, needle) {
    if (!needle) return 0;
    if (haystack === needle) return SCORE.EXACT;
    if (haystack.startsWith(needle)) return SCORE.PREFIX;

    const at = haystack.indexOf(needle);
    if (at < 0) return 0;

    // Совпадение с начала слова весит больше, чем с середины: «мир» в
    // «мираж» — это одно, а в «командир» — совсем другое
    return /[\s\-_.,:;/\\()[\]]/.test(haystack[at - 1]) ? SCORE.WORD : SCORE.INSIDE;
}

/**
 * Готовит запрос к сравнению. Все написания считаются один раз, а не на
 * каждую строку списка.
 *
 * @param {string} query
 * @returns {{score: (text: string) => number, fuzzy: (text: string) => number}|null}
 *          null — запрос пустой, фильтровать нечего
 */
function makeMatcher(query) {
    const folded = fold(query);
    if (!folded) return null;

    // Набранное не в той раскладке — это другой текст, и приводить его
    // к латинице надо уже после подмены клавиш
    const spellings = new Set([folded, latin(folded)]);
    for (const swapped of swapLayout(folded)) {
        spellings.add(swapped);
        spellings.add(latin(swapped));
    }

    const variants = [...spellings].filter(Boolean);
    const words = folded.split(" ").filter(Boolean);
    const latinWords = latin(folded).split(" ").filter(Boolean);

    return {
        /** Дешёвый проход: подстрока в любом из написаний. */
        score(text) {
            const keys = keysOf(text);
            let best = 0;

            // Каждое написание запроса сверяем с обоими написаниями строки.
            // Угадывать, какое из них подойдёт, нельзя: «murakami» — это и
            // готовая латиница, и переписанное «Мураками», и выбрать заранее
            // не выйдет. Лишняя проверка ничего не стоит и не даёт ложных
            // совпадений: кириллица в латинском написании строки не встретится
            for (const v of variants) {
                const value = Math.max(scoreIn(keys.folded, v), scoreIn(keys.latin, v));
                if (value > best) best = value;
                if (best === SCORE.EXACT) return best;
            }

            // Слова по отдельности: «amv аниме» должно находить «Аниме AMV»
            if (!best && words.length > 1) {
                const every = words.every((w) => keys.folded.includes(w)) ||
                    latinWords.every((w) => keys.latin.includes(w));
                if (every) best = SCORE.INSIDE;
            }

            return best;
        },

        /** Дорогой проход: то же, но прощая опечатки. Зовётся, только если дешёвый ничего не дал. */
        fuzzy(text) {
            const keys = keysOf(text);
            // Сверяем со словами строки, а не со всей строкой целиком: иначе
            // длина названия съедала бы весь допуск
            const words = keys.folded.split(" ").concat(keys.latin.split(" "));

            for (const v of variants) {
                const max = allowance(v.length);
                if (!max) continue;

                for (const word of words) {
                    if (withinDistance(v, word, max)) return SCORE.FUZZY;
                }
            }

            return 0;
        },
    };
}

/**
 * Отфильтровать и отсортировать по совпадению.
 *
 * Разбор опечаток включается, только если обычным поиском нашлось меньше
 * ENOUGH: когда список и так полон совпадений, лезть в него неточными
 * незачем — они там только мешают. Заодно это и есть защита от лишней
 * работы на длинных списках.
 *
 * @param {T[]} items
 * @param {string} query
 * @param {(item: T) => string} textOf строка, по которой ищем
 * @param {object} [options]
 * @param {number} [options.limitFuzzy] потолок на число строк, разбираемых
 *        на опечатки: на восьми тысячах полный проход заметен
 * @returns {T[]} в порядке убывания совпадения; при равенстве — как были
 * @template T
 */
function filterByQuery(items, query, textOf, { limitFuzzy = 4000 } = {}) {
    const matcher = makeMatcher(query);
    if (!matcher) return items;

    const ENOUGH = 5;
    const hits = [];

    for (let i = 0; i < items.length; i++) {
        const value = matcher.score(textOf(items[i]));
        if (value) hits.push({ item: items[i], value, i });
    }

    if (hits.length < ENOUGH) {
        const limit = Math.min(items.length, limitFuzzy);
        for (let i = 0; i < limit; i++) {
            if (hits.some((h) => h.i === i)) continue;
            const value = matcher.fuzzy(textOf(items[i]));
            if (value) hits.push({ item: items[i], value, i });
        }
    }

    // Сортировка устойчивая: при равной оценке сохраняется исходный порядок,
    // а он не случайный — это порядок плейлиста
    hits.sort((a, b) => b.value - a.value || a.i - b.i);
    return hits.map((h) => h.item);
}

globalThis.CPD_SEARCH = { fold, makeMatcher, filterByQuery };
})();