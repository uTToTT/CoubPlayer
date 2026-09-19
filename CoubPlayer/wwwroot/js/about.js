// about.js — версия плеера и резервные копии библиотеки.
//
// Живёт в шапке окна плейлистов: это единственное место, где уже собрано
// то, что относится к библиотеке целиком, а не к отдельному ролику.
//
// Зачем копии. Раньше данные лежали в пяти читаемых JSON, и копия делалась
// мышкой. Теперь всё в одном файле базы — плейлисты, порядок, группы,
// баннеры, эффекты, теги. Ролики перекачиваются за вечер, раскладка не
// перекачивается ничем.

import { getVersion, getBackups, createBackup, openBackupsFolder } from "./api.js";
import { showToast } from "./ui.js";

const el = {};
let _loaded = false;

export function initAbout() {
    el.wrap = document.getElementById("appVersionWrap");
    el.button = document.getElementById("appVersion");
    el.menu = document.getElementById("appVersionMenu");
    el.app = document.getElementById("avmApp");
    el.schema = document.getElementById("avmSchema");
    el.latest = document.getElementById("avmLatest");
    el.backupBtn = document.getElementById("avmBackupBtn");
    el.openBtn = document.getElementById("avmOpenBtn");

    if (!el.button) return;

    showVersion();

    el.button.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
    });

    // Клик внутри меню не должен его закрывать: там кнопки и текст,
    // который иногда хочется выделить
    el.menu.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.menu.classList.contains("hidden")) {
            e.stopPropagation();
            close();
        }
    }, true);

    el.backupBtn.addEventListener("click", makeBackup);
    el.openBtn.addEventListener("click", async () => {
        try {
            await openBackupsFolder();
        } catch {
            showToast("⚠ Копий ещё нет");
        }
    });
}

// ─── Версия ─────────────────────────────────────────────────────────────────

/**
 * Не задерживает ничего и молчит при неудаче: версия — справка, а не часть
 * работы. Совсем пустая кнопка лучше, чем ошибка на пустом месте.
 */
async function showVersion() {
    try {
        const v = await getVersion();
        el.button.textContent = `v${v.app}`;
        el.app.textContent = v.app;
        el.schema.textContent = v.schema;

        // Расходятся они только между обновлением и первым запуском —
        // и тогда это как раз то, что хочется увидеть
        if (v.data && v.data !== v.app) {
            el.app.textContent = `${v.app} (данные ${v.data})`;
        }
    } catch {
        el.button.textContent = "";
    }
}

// ─── Меню ───────────────────────────────────────────────────────────────────

function toggle() {
    const willOpen = el.menu.classList.contains("hidden");
    el.menu.classList.toggle("hidden", !willOpen);
    el.wrap.classList.toggle("open", willOpen);

    // Список копий тянем при первом открытии, а не при запуске плеера:
    // большинству он не понадобится ни разу
    if (willOpen && !_loaded) refreshBackups();
}

function close() {
    el.menu.classList.add("hidden");
    el.wrap.classList.remove("open");
}

// ─── Копии ──────────────────────────────────────────────────────────────────

async function refreshBackups() {
    try {
        const { items } = await getBackups();
        _loaded = true;
        el.latest.textContent = items.length ? describeAge(items[0]) : "ещё не делали";
        el.latest.title = items.length
            ? `${items.length} шт., последняя: ${items[0].name}`
            : "";
    } catch {
        el.latest.textContent = "не удалось узнать";
    }
}

async function makeBackup() {
    const previous = el.backupBtn.textContent;
    el.backupBtn.disabled = true;
    el.backupBtn.textContent = "Сохраняю…";

    try {
        const made = await createBackup();
        _loaded = false;
        await refreshBackups();
        showToast(`✓ Копия сохранена — ${Math.round(made.bytes / 1024)} КБ`);
    } catch (err) {
        showToast("⚠ " + (err.message || "Не удалось сохранить копию"));
    } finally {
        el.backupBtn.disabled = false;
        el.backupBtn.textContent = previous;
    }
}

/** «только что», «3 часа назад», «вчера» — точная дата уходит в подсказку. */
function describeAge(backup) {
    const at = Date.parse(backup.createdAt);
    if (!Number.isFinite(at)) return backup.name;

    const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
    if (minutes < 2) return "только что";
    if (minutes < 60) return `${minutes} мин назад`;

    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;

    const days = Math.round(hours / 24);
    return days === 1 ? "вчера" : `${days} дн назад`;
}
