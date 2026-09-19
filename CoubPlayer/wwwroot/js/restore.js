// restore.js
// Возврат роликов, которые числятся в библиотеке и плейлистах, но пропали
// с диска. Файлы скачиваются заново, плейлисты не трогаются — записи в них
// уже есть, не хватало только видео и звука.
//
// Задача живёт на сервере и переживает перезагрузку страницы, поэтому панель
// не хранит состояние сама, а опрашивает сервер и показывает, что он ответил.

import {
    getMissingCoubs, startRestore, getRestoreStatus, stopRestore, getRestoreReport,
} from "./api.js";
import { showToast } from "./ui.js";

const POLL_MS = 1500;

let _panel = null;
let _timer = null;
let _onFinished = null;

/** Опора для обратного отсчёта: сколько оставалось и когда это посчитали. */
let _etaBase = null;

export function initRestore({ onFinished } = {}) {
    _onFinished = onFinished;

    const button = document.getElementById("restoreMissingBtn");
    button?.addEventListener("click", async (e) => {
        e.stopPropagation();
        await handleClick(button);
    });

    // Задача могла остаться запущенной с прошлого захода — тогда сразу
    // показываем панель, не дожидаясь, пока пользователь нажмёт кнопку
    getRestoreStatus()
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
    const status = await getRestoreStatus().catch(() => null);
    if (status?.running) {
        ensurePanel();
        render(status);
        startPolling();
        return;
    }

    const previous = button.textContent;
    button.disabled = true;

    try {
        const { missing } = await getMissingCoubs();

        if (!missing) {
            showToast("✓ Все файлы на месте");
            return;
        }

        const hours = Math.round((missing * 2.2) / 3600);
        const eta = hours >= 1 ? `около ${hours} ч` : "меньше часа";
        const agreed = confirm(
            `Не хватает файлов: ${missing}.\n\n` +
            `Скачать их заново? Займёт ${eta} — можно свернуть окно ` +
            `и продолжать пользоваться плеером, загрузка идёт в фоне.\n\n` +
            `Плейлисты не изменятся: вернутся только файлы.`
        );
        if (!agreed) return;

        const started = await startRestore();
        ensurePanel();
        render(started);
        startPolling();
    } catch (err) {
        console.error("Восстановление:", err);
        showToast("⚠ " + (err.message || "Не удалось начать"));
    } finally {
        button.disabled = false;
        button.textContent = previous;
    }
}

// ─── Опрос ──────────────────────────────────────────────────────────────────

function startPolling() {
    stopPolling();
    _timer = setInterval(async () => {
        try {
            const status = await getRestoreStatus();
            render(status);

            if (!status.running) {
                stopPolling();
                await _onFinished?.();
            }
        } catch {
            // Сервер мог перезапуститься — перестаём опрашивать,
            // но панель оставляем, чтобы было видно последнее состояние
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
            <span class="restore-title">Возвращаю пропавшие</span>
            <button class="restore-hide" type="button" title="Свернуть — загрузка продолжится">✕</button>
        </div>
        <div class="restore-counts">
            <span class="restore-progress">…</span>
            <span class="restore-eta"></span>
        </div>
        <div class="restore-track"><div class="restore-bar"></div></div>
        <div class="restore-foot">
            <span class="restore-note"></span>
            <button class="restore-stop" type="button">Стоп</button>
            <button class="restore-report" type="button" hidden>Что не вернулось</button>
        </div>`;

    _panel.querySelector(".restore-report").addEventListener("click", showReport);

    _panel.querySelector(".restore-hide").addEventListener("click", () => {
        _panel.remove();
        _panel = null;
        // Опрос не останавливаем: задача идёт, и если её открыть снова,
        // панель покажет актуальное состояние
    });

    _panel.querySelector(".restore-stop").addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = "Останавливаю…";
        try { render(await stopRestore()); } catch { }
    });

    document.body.appendChild(_panel);
    return _panel;
}

function render(status) {
    if (!_panel) return;

    const handled = status.done + status.failed + status.gone;
    const total = status.total || 0;

    _panel.querySelector(".restore-progress").textContent =
        total ? `${handled} из ${total}` : "нечего возвращать";

    const bar = _panel.querySelector(".restore-bar");
    bar.style.width = total ? `${(handled / total) * 100}%` : "0%";

    // Оценку пересчитываем только по новым данным от сервера, а между
    // ними просто вычитаем прошедшее — иначе цифра росла бы на глазах
    const eta = estimate(status, handled, total);
    _etaBase = eta == null ? null : { ms: eta, at: Date.now() };
    _panel.querySelector(".restore-eta").textContent =
        eta == null ? "" : `осталось ${formatEta(eta)}`;

    const problems = status.failed + status.gone;
    _panel.querySelector(".restore-note").textContent = problems
        ? `не вернулось ${problems}${status.gone ? ` (удалено с coub.com: ${status.gone})` : ""}`
        : status.current
            ? status.current
            : "";

    const stop = _panel.querySelector(".restore-stop");
    stop.hidden = !status.running;
    stop.disabled = status.stopping;

    const done = status.finished && !status.running;
    _panel.classList.toggle("is-done", done);

    // Разбор «что не вернулось» предлагаем только когда есть что разбирать
    _panel.querySelector(".restore-report").hidden = !done || problems === 0;

    if (done) {
        _panel.querySelector(".restore-title").textContent =
            handled < total ? "Остановлено" : "Готово";
    }
}

// ─── Что не вернулось ───────────────────────────────────────────────────────

/**
 * Показывает итог прохода отдельной страницей: удалённые с coub.com отдельно
 * от тех, что просто не дались. Разделение важное — первые потеряны насовсем,
 * вторые стоит попробовать ещё раз.
 */
async function showReport() {
    const report = await getRestoreReport().catch(() => null);
    if (!report) {
        showToast("⚠ Отчёт недоступен");
        return;
    }

    const gone = report.gone || [];
    const failed = Object.entries(report.failed || {});

    const link = (id) =>
        `<a href="https://coub.com/view/${id}" target="_blank" rel="noreferrer">${id}</a>`;

    const section = (title, note, rows) => rows.length
        ? `<h2>${title} — ${rows.length}</h2><p class="note">${note}</p><ol>${rows.join("")}</ol>`
        : "";

    const html = `<!doctype html><meta charset="utf-8">
<title>Что не вернулось</title>
<style>
 body{background:#0e0e11;color:#eee;font:14px/1.55 system-ui,-apple-system,sans-serif;
      margin:0;padding:28px;max-width:900px}
 h1{font-size:18px;margin:0 0 6px}
 h2{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
    color:rgba(255,255,255,.45);margin:26px 0 4px}
 .head{color:#888;font-size:12.5px;margin-bottom:8px}
 .note{color:#777;font-size:12px;margin:0 0 10px}
 ol{padding-left:2.4em;margin:0}
 li{margin:.15em 0}
 a{color:#f43f5e;font-family:ui-monospace,Consolas,monospace;text-decoration:none}
 a:hover{text-decoration:underline}
 span{color:#777;font-size:12px;margin-left:.6em}
</style>
<h1>Итог восстановления</h1>
<div class="head">Вернулось ${report.restored} из ${report.total}${report.stopped ? " · проход был прерван" : ""}</div>
${section("Удалены с coub.com", "Вернуть нельзя: ролика больше нет у источника.",
        gone.map((id) => `<li>${link(id)}</li>`))}
${section("Не получилось", "Причина временная — стоит запустить восстановление ещё раз.",
        failed.map(([id, why]) => `<li>${link(id)} <span>${why}</span></li>`))}
`;

    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    window.open(url, "_blank");
    // Ссылка нужна только до открытия вкладки, дальше её держать незачем
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Оценка по фактической скорости; до пары скачанных говорить рано. */
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

// Обратный отсчёт идёт сам: сервер отвечает раз в полторы секунды, а ролик
// качается дольше — без этого цифра подолгу стояла бы на месте
setInterval(() => {
    if (!_panel || !_etaBase) return;
    const left = Math.max(0, _etaBase.ms - (Date.now() - _etaBase.at));
    const el = _panel.querySelector(".restore-eta");
    if (el && el.textContent) el.textContent = `осталось ${formatEta(left)}`;
}, 1000);
