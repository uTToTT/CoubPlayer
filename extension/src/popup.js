// popup.js
// Тонкий слой поверх service worker'а: сам ничего не качает, только зовёт
// его и показывает ответ. Всё состояние живёт в worker'е, потому что попап
// закрывается в любой момент.

import { MSG } from "./messages.js";
import { getBaseUrl, setBaseUrl, isBrowserTransfer, setBrowserTransfer } from "./local-api.js";

// Куки, ради которых вся затея: по ним coub.com узнаёт пользователя
const KEY_COOKIES = ["remember_token", "_coub_session", "auth_token"];

const el = {
    serverStatus: document.getElementById("serverStatus"),
    serverUrl: document.getElementById("serverUrl"),
    browserTransfer: document.getElementById("browserTransfer"),
    mode: document.getElementsByName("mode"),
    syncButtons: [...document.querySelectorAll("[data-category]")],
    progress: document.getElementById("progress"),
    progressPhase: document.getElementById("progressPhase"),
    progressCounts: document.getElementById("progressCounts"),
    progressBar: document.getElementById("progressBar"),
    progressEta: document.getElementById("progressEta"),
    stopBtn: document.getElementById("stopBtn"),
    toggleDiag: document.getElementById("toggleDiag"),
    diag: document.getElementById("diag"),
    cookieList: document.getElementById("cookieList"),
    cardButtons: document.getElementById("cardButtons"),
    runProbe: document.getElementById("runProbe"),
    probeResult: document.getElementById("probeResult"),
    readRequests: document.getElementById("readRequests"),
    copyRequests: document.getElementById("copyRequests"),
    requestList: document.getElementById("requestList"),
};

/** Последние записи запросов — их же копирует кнопка «Скопировать». */
let _requests = [];

/** «1 плейлист», «2 плейлиста», «5 плейлистов». */
function plural(n, one, few, many) {
    const mod100 = n % 100;
    const mod10 = n % 10;
    let word = many;
    if (mod100 < 11 || mod100 > 14) {
        if (mod10 === 1) word = one;
        else if (mod10 >= 2 && mod10 <= 4) word = few;
    }
    return `${n} ${word}`;
}

/** Отправляет сообщение в service worker и разворачивает его ответ. */
async function send(type, payload) {
    const res = await chrome.runtime.sendMessage({ type, payload });
    if (!res?.ok) throw new Error(res?.error || "Расширение не ответило");
    return res.data;
}

// ─── Локальный сервер ───────────────────────────────────────────────────────

function setStatus(kind, text, title = "") {
    el.serverStatus.className = `status status--${kind}`;
    el.serverStatus.textContent = text;
    el.serverStatus.title = title;
}

async function checkServer() {
    setStatus("wait", "проверяю…");
    try {
        const info = await send(MSG.PING);
        setStatus("ok", plural(info.playlists.length, "плейлист", "плейлиста", "плейлистов"));
        setButtonsEnabled(true);
    } catch (err) {
        setStatus("err", "не запущен", String(err.message || err));
        setButtonsEnabled(false);
    }
}

function setButtonsEnabled(enabled) {
    for (const btn of el.syncButtons) btn.disabled = !enabled;
}

// ─── Прогресс ───────────────────────────────────────────────────────────────

const PHASE_LABEL = {
    collect: "Собираю ленту",
    download: "Скачиваю",
    done: "Готово",
    error: "Ошибка",
};

/** Последняя известная задача — по ней тикает обратный отсчёт. */
let _job = null;
let _tick = null;

/**
 * Опора для отсчёта: сколько оставалось и когда это посчитали.
 *
 * Между пачками счётчик обработанных стоит на месте, а время идёт — если
 * пересчитывать оценку каждую секунду, она будет расти, что выглядит дико.
 * Поэтому оценка берётся заново только при настоящем обновлении задачи,
 * а между ними просто вычитается прошедшее.
 */
let _etaBase = null;

/**
 * «осталось ~5 мин». Округляем грубо: точность тут всё равно мнимая —
 * ролики разного веса, и сервер выдерживает паузы между ними.
 */
function formatEta(ms) {
    const total = Math.round(ms / 1000);
    if (total < 45) return "меньше минуты";

    const minutes = Math.round(total / 60);
    if (minutes < 60) return `~${minutes} мин`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `~${hours} ч ${rest} мин` : `~${hours} ч`;
}

/**
 * Оценка по фактической скорости с начала скачивания. Пока не обработано
 * хотя бы два ролика, говорить о скорости рано.
 */
function etaFor(job) {
    const total = job.queued || 0;
    const handled = (job.done || 0) + (job.failed || 0);
    if (!job.downloadStartedAt || handled < 2 || handled >= total) return null;

    const elapsed = Date.now() - job.downloadStartedAt;
    const perItem = elapsed / handled;
    return Math.max(0, (total - handled) * perItem);
}

function renderJob(job) {
    _job = job;

    if (!job) {
        el.progress.hidden = true;
        stopTicking();
        return;
    }

    el.progress.hidden = false;
    el.progressPhase.textContent = job.stopping
        ? "Останавливаю…"
        : PHASE_LABEL[job.phase] || job.phase;

    const running = !job.finished;
    el.stopBtn.hidden = !running;
    el.stopBtn.disabled = !!job.stopping;

    if (job.phase === "collect") {
        const pages = job.totalPages ? `${job.page}/${job.totalPages}` : job.page;
        el.progressCounts.textContent = `стр. ${pages} · найдено ${job.collected}`;
        el.progressBar.classList.add("is-indeterminate");
        el.progressBar.style.width = "";
        // Сколько всего страниц в ленте, заранее неизвестно — оценивать нечего
        el.progressEta.textContent = "";
    } else {
        el.progressBar.classList.remove("is-indeterminate");
    }

    if (job.phase === "download") {
        const total = job.queued || 0;
        const handled = (job.done || 0) + (job.failed || 0);
        el.progressCounts.textContent = `${handled} из ${total}`;
        el.progressBar.style.width = total ? `${(handled / total) * 100}%` : "0%";

        const eta = etaFor(job);
        _etaBase = eta == null ? null : { ms: eta, at: Date.now() };
        el.progressEta.textContent = eta == null
            ? "оцениваю время…"
            : `осталось ${formatEta(eta)}`;
    }

    if (job.phase === "done") {
        el.progressBar.style.width = job.stoppedByUser ? el.progressBar.style.width : "100%";
        el.progressPhase.textContent = job.stoppedByUser ? "Остановлено" : "Готово";
        el.progressCounts.textContent = job.queued
            ? `добавлено ${job.done}${job.failed ? `, не вышло ${job.failed}` : ""}`
            : "новых роликов нет";
        el.progressEta.textContent = "";
        setButtonsEnabled(true);
    }

    if (job.phase === "error") {
        el.progressBar.style.width = "0%";
        el.progressCounts.textContent = job.error || "";
        el.progressEta.textContent = "";
        setButtonsEnabled(true);
    }

    // Отсчёт идёт сам, между пачками: иначе цифра замирала бы на минуты
    if (job.phase === "download" && running) startTicking();
    else stopTicking();
}

function startTicking() {
    if (_tick) return;
    _tick = setInterval(() => {
        if (!_etaBase) return;
        const left = Math.max(0, _etaBase.ms - (Date.now() - _etaBase.at));
        el.progressEta.textContent = `осталось ${formatEta(left)}`;
    }, 1000);
}

function stopTicking() {
    clearInterval(_tick);
    _tick = null;
}

// ─── Диагностика кук ────────────────────────────────────────────────────────

async function renderCookies() {
    el.cookieList.textContent = "…";
    try {
        const cookies = await send(MSG.COOKIES);
        if (!cookies.length) {
            el.cookieList.innerHTML =
                `<div class="cookie"><span class="cookie-name">кук нет — войдите на coub.com</span></div>`;
            return;
        }

        el.cookieList.innerHTML = cookies
            .map((c) => {
                const flags = [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite]
                    .filter(Boolean)
                    .join(" · ");
                const isKey = KEY_COOKIES.includes(c.name);
                return `<div class="cookie${isKey ? " cookie--key" : ""}">
                    <span class="cookie-name">${escapeHtml(c.name)}</span>
                    <span class="cookie-flags">${escapeHtml(flags)}</span>
                </div>`;
            })
            .join("");
    } catch (err) {
        el.cookieList.textContent = String(err.message || err);
    }
}

// ─── Разведка API ───────────────────────────────────────────────────────────

async function runProbe() {
    el.runProbe.disabled = true;
    el.runProbe.textContent = "Проверяю…";
    el.probeResult.hidden = false;
    el.probeResult.textContent = "…";

    try {
        const rows = await send(MSG.PROBE);
        el.probeResult.innerHTML = rows
            .map((r) => {
                const ok = r.status === 200;
                return `<div class="cookie${ok ? " cookie--key" : ""}" title="${escapeHtml(r.note)}">
                    <span class="cookie-name">${escapeHtml(r.endpoint)} · ${escapeHtml(r.via)}</span>
                    <span class="cookie-flags">${escapeHtml(r.status)}</span>
                </div>`;
            })
            .join("");
    } catch (err) {
        el.probeResult.textContent = String(err.message || err);
    } finally {
        el.runProbe.disabled = false;
        el.runProbe.textContent = "Проверить доступ к ленте";
    }
}

// ─── Запросы самой страницы ─────────────────────────────────────────────────

/** Короткое имя запроса: процедуры tRPC или хвост пути. */
function shortName(url) {
    try {
        const { pathname } = new URL(url);
        const trpc = pathname.match(/\/api\/trpc\/(.+)$/);
        if (trpc) {
            // Батч повторяет одну и ту же процедуру много раз — схлопываем
            const unique = [...new Set(trpc[1].split(","))];
            return unique.join(", ");
        }
        return pathname;
    } catch {
        return url;
    }
}

async function readRequests() {
    el.readRequests.disabled = true;
    el.requestList.hidden = false;
    el.requestList.textContent = "…";

    try {
        _requests = await send(MSG.PAGE_REQUESTS);
        el.copyRequests.disabled = !_requests.length;

        if (!_requests.length) {
            el.requestList.innerHTML =
                `<div class="cookie"><span class="cookie-name">пусто — откройте нужную страницу coub.com и пролистайте её</span></div>`;
            return;
        }

        el.requestList.innerHTML = _requests
            .slice(0, 40)
            .map((r) => {
                const ok = r.status === 200 || r.status === 204;
                return `<div class="cookie${ok ? " cookie--key" : ""}" title="${escapeHtml(r.url)}">
                    <span class="cookie-name">${escapeHtml(r.method)} ${escapeHtml(shortName(r.url))}</span>
                    <span class="cookie-flags">${escapeHtml(r.status ?? "…")}${r.auth ? " · auth" : ""}</span>
                </div>`;
            })
            .join("");
    } catch (err) {
        _requests = [];
        el.copyRequests.disabled = true;
        el.requestList.textContent = String(err.message || err);
    } finally {
        el.readRequests.disabled = false;
    }
}

async function copyRequests() {
    await navigator.clipboard.writeText(JSON.stringify(_requests, null, 2));
    el.copyRequests.textContent = "Скопировано";
    setTimeout(() => (el.copyRequests.textContent = "Скопировать"), 1500);
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"]/g, (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])
    );
}

// ─── Разметка событий ───────────────────────────────────────────────────────

el.serverUrl.addEventListener("change", async () => {
    await setBaseUrl(el.serverUrl.value.trim());
    checkServer();
});

for (const btn of el.syncButtons) {
    btn.addEventListener("click", async () => {
        const mode = [...el.mode].find((r) => r.checked)?.value || "new";
        setButtonsEnabled(false);
        try {
            await send(MSG.SYNC, { category: btn.dataset.category, mode });
        } catch {
            // Ошибку покажет renderJob — worker положил её в состояние задачи
        }
    });
}

el.toggleDiag.addEventListener("click", () => {
    el.diag.hidden = !el.diag.hidden;
    if (!el.diag.hidden) renderCookies();
});

el.stopBtn.addEventListener("click", async () => {
    el.stopBtn.disabled = true;
    el.progressPhase.textContent = "Останавливаю…";
    try {
        await send(MSG.STOP);
    } catch {
        el.stopBtn.disabled = false;
    }
});

el.runProbe.addEventListener("click", runProbe);
el.readRequests.addEventListener("click", readRequests);
el.copyRequests.addEventListener("click", copyRequests);

el.browserTransfer.addEventListener("change", () => {
    setBrowserTransfer(el.browserTransfer.checked);
});

el.cardButtons.addEventListener("change", () => {
    // content script слушает storage и сам добавит или снимет кнопки
    chrome.storage.local.set({ cardButtons: el.cardButtons.checked });
});

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MSG.PROGRESS) renderJob(message.job);
});

// ─── Старт ──────────────────────────────────────────────────────────────────

(async function init() {
    const { cardButtons } = await chrome.storage.local.get("cardButtons");
    el.cardButtons.checked = cardButtons !== false;

    el.serverUrl.value = await getBaseUrl();
    el.browserTransfer.checked = await isBrowserTransfer();
    await checkServer();
    // Загрузка могла начаться при прошлом открытии попапа и идти до сих пор
    renderJob(await send(MSG.JOB).catch(() => null));
})();
