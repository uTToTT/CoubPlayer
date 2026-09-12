// coub-api.js
// Приватный API coub.com — единственное, ради чего вообще нужно расширение.
//
// Скачать отдельный куб сервер умеет и без авторизации. Не хватает ему только
// СПИСКА: «что этот пользователь лайкнул». Этот список отдаёт timeline API,
// и только залогиненному.

import { MSG } from "./messages.js";

// Старый /api/v2/ мёртв: ленты отвечают 403, users/me — 404. Сегодняшний
// сайт ходит сюда, обычным GET с куками, без всякого Authorization.
const TIMELINE_ENDPOINT = "https://coub.com/api/coub-site/timeline";

/**
 * Имена лент в адресе. Внимание: неизвестный scope API молча игнорирует и
 * отдаёт общую ленту «горячего» — то есть опечатка здесь означала бы не
 * ошибку, а тихую закачку чужих роликов. Эти два значения проверены: аноним
 * получает по ним пустой список, а не подмену.
 */
const SCOPE = {
    liked: "likes",
    bookmarks: "bookmarks",
};

/**
 * Даёт 200 залогиненному и 401 анониму. Нужен, чтобы отличить «лента пуста»
 * от «сессии нет»: сама лента в обоих случаях возвращает 200 и items: [].
 */
const AUTH_CHECK_ENDPOINT = "https://coub.com/api/realtime/token";

// Страница отдаёт 5–10 роликов, размер не настраивается. Пауза поменьше
// прежних двух секунд: это тот же запрос, что делает сайт при прокрутке.
const PAGE_DELAY_MS = 700;

// Предохранитель от бесконечного обхода, если курсор вдруг зациклится
const MAX_PAGES = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Диагностика кук ────────────────────────────────────────────────────────

/**
 * Что расширение видит в куках coub.com. HttpOnly-куки из document.cookie
 * не читаются, а этим API — читаются.
 *
 * Значения наружу не отдаём: попапу достаточно имён и флагов.
 */
export async function inspectCookies() {
    const cookies = await chrome.cookies.getAll({ domain: "coub.com" });
    return cookies
        .map((c) => ({
            name: c.name,
            domain: c.domain,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
            size: c.value.length,
            expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Токен Supabase ─────────────────────────────────────────────────────────
// coub.com перешёл на Supabase GoTrue: вместо remember_token в куках лежит
// sb-gotrue-auth-token с JSON-сессией. Приватный API, похоже, ждёт из неё
// access_token в заголовке Authorization, а не саму куку.

const SUPABASE_COOKIE = "sb-gotrue-auth-token";

/** base64url → строка, с учётом кириллицы в полезной нагрузке. */
function decodeBase64(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/**
 * Достаёт access_token из куки Supabase.
 *
 * Формат гуляет от версии к версии: то голый JSON, то он же с префиксом
 * "base64-", то объект, то массив [access_token, refresh_token, …]. Большие
 * сессии Supabase режет на куски sb-…-auth-token.0, .1 — их надо склеить
 * по порядку.
 *
 * @returns {Promise<{token: string|null, expiresAt: number|null, reason?: string}>}
 */
export async function readSupabaseToken() {
    const cookies = await chrome.cookies.getAll({ domain: "coub.com" });
    const parts = cookies
        .filter((c) => c.name === SUPABASE_COOKIE || c.name.startsWith(SUPABASE_COOKIE + "."))
        .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

    if (!parts.length) return { token: null, expiresAt: null, reason: "куки Supabase нет — войдите на coub.com" };

    let raw = parts.map((c) => c.value).join("");
    try {
        raw = decodeURIComponent(raw);
    } catch {
        // значение может быть и не закодировано — тогда оставляем как есть
    }

    if (raw.startsWith("base64-")) {
        try {
            raw = decodeBase64(raw.slice("base64-".length));
        } catch {
            return { token: null, expiresAt: null, reason: "не удалось раскодировать base64 в куке" };
        }
    }

    let session;
    try {
        session = JSON.parse(raw);
    } catch {
        return { token: null, expiresAt: null, reason: "кука не разобралась как JSON" };
    }

    // Массив: [access_token, refresh_token, provider_token, …]
    const token = Array.isArray(session) ? session[0] : session?.access_token;
    if (!token) return { token: null, expiresAt: null, reason: "в сессии нет access_token" };

    const expiresAt = Array.isArray(session) ? null : session.expires_at ?? null;
    return { token, expiresAt };
}

// ─── Способы сходить в API ──────────────────────────────────────────────────
// Запись запросов самого сайта показала: лента ходит на одних куках, никакого
// Authorization там нет. Остаются два способа:
//
//   direct — fetch с куками из service worker'а. Запрос уходит с origin
//            расширения, и прикрепит ли Chrome куку — зависит от его версии
//            и от SameSite самой куки.
//   tab    — тот же запрос руками content script'а на открытой вкладке
//            coub.com. Там он заведомо first-party, куки уходят всегда.
//
// Сработавший способ запоминается, чтобы не перебирать их на каждой странице.
// bearer остался только для разведки: вдруг какая-то часть API его всё же ждёт.

const TRANSPORTS = ["direct", "tab"];

const JSON_HEADERS = {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
};

/** Запрос из service worker'а. */
async function fetchDirect(url, headers = {}) {
    const res = await fetch(url, {
        credentials: "include",
        headers: { ...JSON_HEADERS, ...headers },
    });
    return { status: res.status, body: await res.text() };
}

/** Он же, но с токеном Supabase. */
async function fetchBearer(url) {
    const { token, reason } = await readSupabaseToken();
    if (!token) throw new Error(reason || "нет токена Supabase");
    return fetchDirect(url, { Authorization: `Bearer ${token}` });
}

/** Запрос руками открытой вкладки coub.com. */
async function fetchViaTab(url) {
    const tabs = await chrome.tabs.query({ url: "https://coub.com/*" });
    if (!tabs.length) {
        throw new Error("Откройте вкладку с coub.com — без неё этот способ не работает");
    }

    // Вкладка могла быть выгружена из памяти (discarded) — тогда content script
    // в ней не живёт и сообщение просто не дойдёт
    const alive = tabs.find((t) => !t.discarded) || tabs[0];
    const { token } = await readSupabaseToken();

    return chrome.tabs.sendMessage(alive.id, {
        type: MSG.COUB_FETCH,
        url,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
}

const FETCHERS = { bearer: fetchBearer, direct: fetchDirect, tab: fetchViaTab };

/**
 * Какой способ сработал в прошлый раз.
 * @type {"bearer"|"direct"|"tab"|null}
 */
let _preferred = null;

/** Сбрасывает выбор способа — например, когда пользователь перелогинился. */
export function resetTransport() {
    _preferred = null;
}

/**
 * Один запрос к API с перебором способов.
 * @returns {Promise<{status: number, body: string, via: string}>}
 */
async function apiFetch(url) {
    const order = _preferred
        ? [_preferred, ...TRANSPORTS.filter((t) => t !== _preferred)]
        : TRANSPORTS;

    let lastError = null;
    for (const via of order) {
        try {
            const res = await FETCHERS[via](url);

            // 401/403 — «не узнал пользователя»: имеет смысл попробовать другой
            // способ. Остальные коды вернём как есть, их разберёт вызывающий
            if (res.status === 401 || res.status === 403) {
                lastError = new Error(`${via}: coub.com ответил ${res.status}`);
                continue;
            }

            _preferred = via;
            return { ...res, via };
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError ?? new Error("Не удалось обратиться к API coub.com");
}

// ─── Разведка ───────────────────────────────────────────────────────────────

/**
 * Перебирает все способы по всем интересным адресам и возвращает, что ответил
 * каждый. После переезда coub.com на Supabase это единственный способ узнать,
 * какой запрос сайт вообще принимает — угадать нельзя.
 *
 * @returns {Promise<Array<{endpoint: string, via: string, status: number|string, note: string}>>}
 */
export async function probe() {
    const endpoints = {
        "сессия": AUTH_CHECK_ENDPOINT,
        "лайки": `${TIMELINE_ENDPOINT}?kind=hot&scope=${SCOPE.liked}&locale=ru`,
        "закладки": `${TIMELINE_ENDPOINT}?kind=hot&scope=${SCOPE.bookmarks}&locale=ru`,
    };

    // bearer здесь на всякий случай: лента его не требует, но если какая-то
    // часть API однажды попросит токен — это станет видно сразу
    const ways = [...TRANSPORTS, "bearer"];

    const rows = [];
    for (const [name, url] of Object.entries(endpoints)) {
        for (const via of ways) {
            try {
                const res = await FETCHERS[via](url);
                rows.push({ endpoint: name, via, status: res.status, note: describeBody(res) });
            } catch (err) {
                rows.push({ endpoint: name, via, status: "—", note: String(err.message || err) });
            }
        }
    }
    return rows;
}

/**
 * Что вызывала сама страница coub.com — собирает записи со всех открытых
 * её вкладок. Единственный надёжный способ узнать текущие адреса приватного
 * API: /api/v2/ сменился на tRPC, а ленты открыты только залогиненному.
 *
 * @returns {Promise<Array<object>>} записи от новых к старым
 */
export async function pageRequests() {
    const tabs = await chrome.tabs.query({ url: "https://coub.com/*" });
    if (!tabs.length) throw new Error("Нет открытых вкладок coub.com");

    const batches = await Promise.all(
        tabs
            .filter((t) => !t.discarded)
            .map((t) =>
                chrome.tabs
                    .sendMessage(t.id, { type: MSG.PAGE_REQUESTS })
                    .catch(() => [])
            )
    );

    return batches
        .flat()
        .sort((a, b) => b.at - a.at)
        .map(({ at, ...rest }) => rest);
}

/** Коротко о том, что пришло в ответ: сколько роликов или что за ошибка. */
function describeBody({ status, body }) {
    if (status !== 200) return (body || "").slice(0, 120);
    try {
        const data = JSON.parse(body);
        if (Array.isArray(data.items)) {
            return `роликов: ${data.items.length}${data.next ? ", есть продолжение" : ""}`;
        }
        return "ответ разобран";
    } catch {
        return "ответ не JSON";
    }
}

// ─── Лента ──────────────────────────────────────────────────────────────────

/** Есть ли на coub.com живая сессия. */
export async function isAuthenticated() {
    try {
        const res = await apiFetch(AUTH_CHECK_ENDPOINT);
        return res.status === 200;
    } catch {
        return false;
    }
}

/**
 * Собирает permalink'и из ленты, от новых к старым.
 *
 * Листается курсором, а не номерами страниц: ответ приходит в виде
 * `{ items: [...], next: "<курсор>" }`, где next надо вернуть обратно
 * параметром cursor. Сколько всего страниц — заранее неизвестно, поэтому
 * прогресс показывает найденное, а не долю.
 *
 * @param {"liked"|"bookmarks"} category
 * @param {object} options
 * @param {number} [options.limit] сколько собрать; -1 — всю ленту
 * @param {(state: {page: number, totalPages: null, collected: number}) => void} [options.onPage]
 * @param {(permalinks: string[]) => boolean} [options.stopWhen]
 *        вызывается после каждой страницы; вернув true, обрывает обход
 * @param {() => boolean} [options.shouldStop]
 *        проверяется перед каждой страницей — так работает кнопка «Стоп»
 * @returns {Promise<{permalinks: string[], via: string, stopped: boolean}>}
 */
export async function collectPermalinks(
    category,
    { limit = -1, onPage, stopWhen, shouldStop } = {}
) {
    const scope = SCOPE[category];
    if (!scope) throw new Error(`Неизвестная категория: ${category}`);

    const max = limit < 0 ? Infinity : limit;
    const permalinks = [];
    const seen = new Set();

    let cursor = null;
    let page = 0;
    let via = "direct";
    let stopped = false;

    while (permalinks.length < max && page < MAX_PAGES) {
        if (shouldStop?.()) {
            stopped = true;
            break;
        }

        const url =
            `${TIMELINE_ENDPOINT}?kind=hot&scope=${scope}&locale=ru` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

        const res = await apiFetch(url);
        via = res.via;
        page++;

        if (res.status === 401 || res.status === 403) {
            throw new Error(
                page === 1
                    ? "coub.com не узнал пользователя — войдите на сайте и повторите"
                    : `coub.com отдал ${res.status} на странице ${page} — похоже на ограничение по частоте, попробуйте позже`
            );
        }
        if (res.status !== 200) {
            throw new Error(`coub.com ответил ${res.status} на странице ${page}`);
        }

        const data = JSON.parse(res.body);
        const items = Array.isArray(data.items) ? data.items : [];

        // Пустая лента и отсутствие сессии выглядят одинаково: и то и другое
        // приходит как 200 с items: []. Различаем их отдельной проверкой
        if (!items.length && page === 1 && !(await isAuthenticated())) {
            throw new Error("Нет сессии coub.com — войдите на сайте и повторите");
        }

        const fresh = [];
        for (const item of items) {
            if (permalinks.length + fresh.length >= max) break;
            const permalink = item?.permalink;
            if (!permalink || seen.has(permalink)) continue;
            seen.add(permalink);
            fresh.push(permalink);
        }
        permalinks.push(...fresh);

        onPage?.({ page, totalPages: null, collected: permalinks.length });

        if (stopWhen?.(fresh)) {
            stopped = true;
            break;
        }
        if (permalinks.length >= max) break;

        // Курсора нет — лента кончилась
        if (!data.next) break;
        cursor = data.next;

        await sleep(PAGE_DELAY_MS);
    }

    return { permalinks, via, stopped };
}

/**
 * Permalink куба из адреса страницы или ссылки.
 * Годится и для https://coub.com/view/abc123, и для голого abc123.
 */
export function permalinkFromUrl(url) {
    if (!url) return null;
    const match = String(url).match(/coub\.com\/view\/([\w-]+)/);
    if (match) return match[1];
    return /^[\w-]+$/.test(url) ? url : null;
}
