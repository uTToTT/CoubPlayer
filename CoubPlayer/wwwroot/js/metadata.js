// metadata.js
// Дозагрузка сведений о роликах от Coub: канал, длительность, размер кадра,
// nsfw и теги самого сайта.
//
// В файлах ролика этого нет, а подсказка «куда положить и что повесить»
// строится только на них. Восемь тысяч роликов — часы обхода с паузами,
// поэтому задача живёт на сервере, переживает перезагрузку страницы и
// опрашивается отсюда.
//
// Панель та же, что у возврата пропавших файлов (стили restore-*): обе
// задачи одинаковы по сути — долгий обход coub.com с прогрессом и
// остановкой. Одновременно они не запускаются, сервер это запрещает.

import {
    getMetadataPending, startMetadata, getMetadataStatus, stopMetadata,
} from "./api.js";
import { showToast } from "./ui.js";

const POLL_MS = 1500;

let _panel = null;
let _timer = null;
let _onFinished = null;

/** Опора для обратного отсчёта: сколько оставалось и когда это посчитали. */
let _etaBase = null;

export function initMetadata({ onFinished } = {}) {
    _onFinished = onFinished;

    const button = document.getElementById("fetchMetadataBtn");
    button?.addEventListener("click", async (e) => {
        e.stopPropagation();
        await handleClick(button);
    });

    // Задача могла остаться запущенной с прошлого захода
    getMetadataStatus()
        .then((status) => {
            if (status.running) {
                ensurePanel();
                render(status);
                startPolling();
            }
        })
        .catch(() => { });
}

async function handleClick(button) {
    const status = await getMetadataStatus().catch(() => null);
    if (status?.running) {
        ensurePanel();
        render(status);
        startPolling();
        return;
    }

    button.disabled = true;

    try {
        const { pending } = await getMetadataPending();

        if (!pending) {
            showToast("✓ Сведения есть обо всех роликах");
            return;
        }

        // Каждый ролик — один запрос с паузой около двух секунд
        const hours = Math.round((pending * 2.2) / 3600);
        const eta = hours >= 1 ? `около ${hours} ч` : "меньше часа";
        const agreed = confirm(
            `Нет сведений о ${pending} роликах.\n\n` +
            `Спросить о них у coub.com? Займёт ${eta} — можно свернуть окно ` +
            `и продолжать пользоваться плеером, обход идёт в фоне.\n\n` +
            `Файлы и плейлисты не изменятся: добавятся только канал, ` +
            `длительность и теги самого сайта.`
        );
        if (!agreed) return;

        const started = await startMetadata();
        ensurePanel();
        render(started);
        startPolling();
    } catch (err) {
        console.error("Метаданные:", err);
        showToast("⚠ " + (err.message || "Не удалось начать"));
    } finally {
        button.disabled = false;
    }
}

// ─── Опрос ──────────────────────────────────────────────────────────────────

function startPolling() {
    stopPolling();
    _timer = setInterval(async () => {
        try {
            const status = await getMetadataStatus();
            render(status);

            if (!status.running) {
                stopPolling();
                await _onFinished?.();
            }
        } catch {
            // Сервер мог перезапуститься — перестаём опрашивать, но панель
            // оставляем, чтобы было видно последнее состояние
            stopPolling();
        }
    }, POLL_MS);
}

function stopPolling() {
    clearInterval(_timer);
    _timer = null;
}

// ─── Панель ─────────────────────────────────────────────────────────────────

function ensurePanel() {
    if (_panel) return _panel;

    _panel = document.createElement("div");
    _panel.className = "restore-panel";
    _panel.innerHTML = `
        <div class="restore-head">
            <span class="restore-title">Собираю сведения</span>
            <button class="restore-hide" type="button" title="Свернуть — обход продолжится">✕</button>
        </div>
        <div class="restore-counts">
            <span class="restore-progress">…</span>
            <span class="restore-eta"></span>
        </div>
        <div class="restore-track"><div class="restore-bar"></div></div>
        <div class="restore-foot">
            <span class="restore-note"></span>
            <button class="restore-stop" type="button">Стоп</button>
        </div>`;

    _panel.querySelector(".restore-hide").addEventListener("click", () => {
        _panel.remove();
        _panel = null;
        // Опрос не останавливаем: задача идёт, и при повторном открытии
        // панель покажет актуальное состояние
    });

    _panel.querySelector(".restore-stop").addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = "Останавливаю…";
        try { render(await stopMetadata()); } catch { }
    });

    document.body.appendChild(_panel);
    return _panel;
}

function render(status) {
    if (!_panel) return;

    const handled = status.done + status.gone + status.failed;
    const total = status.total || 0;

    _panel.querySelector(".restore-progress").textContent =
        total ? `${handled} из ${total}` : "нечего собирать";

    const bar = _panel.querySelector(".restore-bar");
    bar.style.width = total ? `${(handled / total) * 100}%` : "0%";

    // Оценку пересчитываем только по новым данным от сервера, а между ними
    // просто вычитаем прошедшее — иначе цифра росла бы на глазах
    const eta = estimate(status, handled, total);
    _etaBase = eta == null ? null : { ms: eta, at: Date.now() };
    _panel.querySelector(".restore-eta").textContent =
        eta == null ? "" : `осталось ${formatEta(eta)}`;

    const problems = [];
    if (status.gone) problems.push(`удалено с сайта ${status.gone}`);
    if (status.failed) problems.push(`не вышло ${status.failed}`);

    _panel.querySelector(".restore-note").textContent =
        problems.length ? problems.join(", ") : (status.current || "");

    const stop = _panel.querySelector(".restore-stop");
    stop.hidden = !status.running;
    stop.disabled = status.stopping;

    const done = status.finished && !status.running;
    _panel.classList.toggle("is-done", done);

    if (done) {
        _panel.querySelector(".restore-title").textContent =
            handled < total ? "Остановлено" : "Готово";

        // Не вышедшие остались без отметки и попадут в следующий проход —
        // про это стоит сказать прямо, иначе повтор выглядит бессмысленным
        if (status.failed) {
            _panel.querySelector(".restore-note").textContent =
                `не вышло ${status.failed} — попробуйте ещё раз позже`;
        }
    }
}

/** Оценка по фактической скорости; до пары обработанных говорить рано. */
function estimate(status, handled, total) {
    if (!status.running || !status.startedAt || handled < 2 || handled >= total) return null;

    const elapsed = Date.now() - status.startedAt;
    return Math.max(0, ((total - handled) * elapsed) / handled);
}

function formatEta(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return "меньше минуты";
    if (minutes < 60) return `~${minutes} мин`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `~${hours} ч ${rest} мин` : `~${hours} ч`;
}

// Обратный отсчёт идёт сам: сервер отвечает раз в полторы секунды, а пауза
// между роликами дольше — без этого цифра подолгу стояла бы на месте
setInterval(() => {
    if (!_panel || !_etaBase) return;
    const left = Math.max(0, _etaBase.ms - (Date.now() - _etaBase.at));
    const el = _panel.querySelector(".restore-eta");
    if (el && el.textContent) el.textContent = `осталось ${formatEta(left)}`;
}, 1000);
