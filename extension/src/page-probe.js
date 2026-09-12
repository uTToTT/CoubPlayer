// page-probe.js
// Работает в MAIN world — то есть в том же мире, что и код самого coub.com,
// а не в изолированном мире content script'а. Только оттуда видно, что
// страница вызывает своим fetch/XHR.
//
// Зачем: coub.com переехал с /api/v2/ на tRPC (/api/trpc/…) и /api/coub-site/,
// ленты лайков и закладок открываются только залогиненному. Угадывать адреса
// бессмысленно — проще подсмотреть, что сайт делает сам.
//
// Ничего не блокирует и не меняет: оборачивает вызовы, пишет в кольцевой
// буфер и отдаёт его по запросу. Значения токенов наружу не выходят —
// только схема авторизации и длина.

(() => {
    "use strict";

    const LIMIT = 300;
    const records = [];

    /** Интересны только обращения к API — статика и картинки шумят. */
    function isInteresting(url) {
        try {
            const parsed = new URL(url, location.href);
            if (parsed.pathname.includes("/api/")) return true;
            // Сторонний хост (например, Supabase) — тоже интересен
            return parsed.origin !== location.origin;
        } catch {
            return false;
        }
    }

    /**
     * Из заголовка Authorization оставляем только схему и длину:
     * нам нужно знать «Bearer или нет», а сам токен наружу не нужен.
     */
    function describeAuth(value) {
        if (!value) return null;
        const [scheme] = String(value).split(" ");
        return `${scheme} (${String(value).length} символов)`;
    }

    /**
     * Кладём саму запись, а не копию: код статуса дописывается позже, когда
     * запрос завершится, и должен попасть именно в то, что лежит в буфере.
     */
    function push(entry) {
        entry.at = Date.now();
        records.push(entry);
        if (records.length > LIMIT) records.shift();
        return entry;
    }

    function headersToObject(headers) {
        const out = {};
        try {
            if (!headers) return out;
            if (typeof Headers !== "undefined" && headers instanceof Headers) {
                headers.forEach((v, k) => (out[k.toLowerCase()] = v));
            } else if (Array.isArray(headers)) {
                for (const [k, v] of headers) out[String(k).toLowerCase()] = v;
            } else {
                for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
            }
        } catch {
            // чужие заголовки могут быть чем угодно — не роняем страницу из-за них
        }
        return out;
    }

    // ─── fetch ──────────────────────────────────────────────────────────────

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        window.fetch = function (input, init) {
            const promise = originalFetch.apply(this, arguments);

            try {
                const url = typeof input === "string" ? input : input?.url;
                if (url && isInteresting(url)) {
                    const headers = headersToObject(init?.headers ?? input?.headers);
                    const entry = {
                        kind: "fetch",
                        method: (init?.method || input?.method || "GET").toUpperCase(),
                        url,
                        auth: describeAuth(headers.authorization),
                        headerNames: Object.keys(headers),
                        status: null,
                    };
                    push(entry);
                    promise.then(
                        (res) => { entry.status = res.status; },
                        () => { entry.status = "сбой"; }
                    );
                }
            } catch {
                // запись не должна мешать самому запросу
            }

            return promise;
        };
    }

    // ─── XMLHttpRequest ─────────────────────────────────────────────────────

    const xhr = XMLHttpRequest.prototype;
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    const originalSetHeader = xhr.setRequestHeader;

    xhr.open = function (method, url) {
        try {
            this.__cpd = { kind: "xhr", method: String(method).toUpperCase(), url, headers: {} };
        } catch { }
        return originalOpen.apply(this, arguments);
    };

    xhr.setRequestHeader = function (name, value) {
        try {
            if (this.__cpd) this.__cpd.headers[String(name).toLowerCase()] = value;
        } catch { }
        return originalSetHeader.apply(this, arguments);
    };

    xhr.send = function () {
        try {
            const meta = this.__cpd;
            if (meta && isInteresting(meta.url)) {
                const entry = {
                    kind: "xhr",
                    method: meta.method,
                    url: meta.url,
                    auth: describeAuth(meta.headers.authorization),
                    headerNames: Object.keys(meta.headers),
                    status: null,
                };
                push(entry);
                this.addEventListener("loadend", () => { entry.status = this.status; });
            }
        } catch { }
        return originalSend.apply(this, arguments);
    };

    // ─── Выдача записей ─────────────────────────────────────────────────────
    // Общаемся через postMessage: MAIN world и изолированный мир content
    // script'а не видят переменных друг друга, но окно у них общее.

    window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        if (event.data?.source !== "cpd-probe-request") return;

        window.postMessage(
            { source: "cpd-probe-response", records: records.slice(-LIMIT) },
            location.origin
        );
    });
})();
