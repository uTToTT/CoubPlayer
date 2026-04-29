// ui.js
// Весь рендеринг UI. Playlist editor работает по Pinterest-паттерну:
// мгновенное сохранение при клике, без кнопки «Сохранить».

// ─── Playlist Dropdown ────────────────────────────────────────────────────────

const playlistMenu    = document.getElementById("playlistMenu");
const playlistTrigger = document.querySelector("#playlistDropdown .select-trigger");

export function renderPlaylistDropdown(playlists, onSelect, onCreate) {
    playlistMenu.innerHTML = "";

    for (const [name, data] of Object.entries(playlists)) {
        const count = Object.keys(data.videos || {}).length;
        const el = document.createElement("div");
        el.className = "select-option";
        el.textContent = `${name} (${count})`;
        el.onclick = () => onSelect(name);
        playlistMenu.appendChild(el);
    }

    const newEl = document.createElement("div");
    newEl.className = "select-option create-new";
    newEl.textContent = "+ Создать плейлист";
    newEl.onclick = onCreate;
    playlistMenu.appendChild(newEl);
}

export function setPlaylistTriggerLabel(name) {
    playlistTrigger.textContent = `${name} ▼`;
}

export function togglePlaylistMenu() {
    playlistMenu.classList.toggle("hidden");
}

export function hidePlaylistMenu() {
    playlistMenu.classList.add("hidden");
}

// ─── Video Info ───────────────────────────────────────────────────────────────

const videoTitleLabel = document.getElementById("videoTitleLabel");
const videoIndexInput = document.getElementById("videoIndexInput");
const videoTotal      = document.getElementById("videoTotal");

export function updateVideoInfo(index, title, total) {
    videoTitleLabel.textContent = title || "—";
    videoIndexInput.value       = index + 1;
    videoTotal.textContent      = `/ ${total}`;
}

// ─── Volume Slider ────────────────────────────────────────────────────────────

const volumeSlider = document.getElementById("volumeSlider");

export function initVolumeSlider(onChange) {
    const update = (value) => {
        volumeSlider.style.setProperty("--value", value + "%");
        onChange(value);
    };
    volumeSlider.addEventListener("input", (e) => update(e.target.value));
    update(volumeSlider.value);
}

// ─── Copy Link Button ─────────────────────────────────────────────────────────

const copyLinkBtn = document.getElementById("copyLinkBtn");

export function initCopyLinkBtn(getCurrentVideoId) {
    copyLinkBtn.addEventListener("click", async () => {
        const id = getCurrentVideoId();
        if (!id) return;
        try {
            await navigator.clipboard.writeText(`https://coub.com/view/${id}`);
            copyLinkBtn.textContent = "✓";
            setTimeout(() => (copyLinkBtn.textContent = "🔗"), 1200);
        } catch (e) {
            console.error("Clipboard error:", e);
        }
    });
}

// ─── Sort Bar ─────────────────────────────────────────────────────────────────

const sortTypeGroup    = document.getElementById("sortTypeGroup");
const sortDirectionBtn = document.getElementById("sortDirectionBtn");
const seedInput        = document.getElementById("seedInput");

export function initSortBar(onChange) {
    let sortType      = "order";
    let sortDirection = "asc";

    const notify = () => onChange(sortType, sortDirection, parseInt(seedInput.value) || 1);

    sortTypeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        [...sortTypeGroup.children].forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        sortType = btn.dataset.type;
        seedInput.classList.toggle("hidden", sortType !== "random");
        notify();
    });

    sortDirectionBtn.addEventListener("click", () => {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
        sortDirectionBtn.textContent = sortDirection === "asc" ? "↑" : "↓";
        notify();
    });

    seedInput.addEventListener("change", notify);
}

// ═════════════════════════════════════════════════════════════════════════════
// PLAYLIST EDITOR — Pinterest-style
// Мгновенное сохранение по клику. Нет кнопки "Сохранить".
// ═════════════════════════════════════════════════════════════════════════════

const READONLY_PLAYLISTS = ["bookmarks", "liked"];

// DOM-элементы редактора
const overlay       = document.getElementById("playlistEditorOverlay");
const panel         = document.getElementById("playlistEditorPanel");
const subtitle      = document.getElementById("plEditorSubtitle");
const closeBtn      = document.getElementById("plEditorClose");
const searchInput   = document.getElementById("plSearchInput");
const searchClear   = document.getElementById("plSearchClear");
const listEl        = document.getElementById("plEditorList");
const newBtn        = document.getElementById("plNewBtn");

// Тост-уведомление (создаём программно, чтобы не захламлять HTML)
const toast = document.createElement("div");
toast.className = "pl-toast";
document.body.appendChild(toast);

let _playlists        = {};   // ссылка на state.playlists
let _currentVideoId   = null;
let _currentTitle     = "";
let _onToggle         = null; // (playlistName, add: boolean) => Promise<void>
let _onCreatePlaylist = null; // () => Promise<string|null>

/**
 * Инициализация редактора. Вызывается один раз из main.js.
 *
 * @param {{
 *   getPlaylists: () => Record<string, any>,
 *   onToggle: (name: string, add: boolean) => Promise<void>,
 *   onCreatePlaylist: () => Promise<string|null>
 * }} opts
 */
export function initPlaylistEditor({ getPlaylists, onToggle, onCreatePlaylist }) {
    _onToggle         = onToggle;
    _onCreatePlaylist = onCreatePlaylist;

    // Закрытие по кнопке ✕
    closeBtn.addEventListener("click", closeEditor);

    // Закрытие по клику на оверлей вне панели
    overlay.addEventListener("click", (e) => {
        if (!panel.contains(e.target)) closeEditor();
    });

    // Поиск
    searchInput.addEventListener("input", () => {
        const q = searchInput.value.trim();
        searchClear.classList.toggle("hidden", !q);
        renderRows(q);
    });

    searchClear.addEventListener("click", () => {
        searchInput.value = "";
        searchClear.classList.add("hidden");
        searchInput.focus();
        renderRows("");
    });

    // Новый плейлист
    newBtn.addEventListener("click", async () => {
        if (!_onCreatePlaylist) return;
        const name = await _onCreatePlaylist();
        if (name) {
            _playlists = getPlaylists();
            renderRows(searchInput.value.trim());
        }
    });

    // ESC закрывает
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && overlay.classList.contains("show")) {
            closeEditor();
        }
    });
}

/**
 * Открыть редактор для конкретного видео.
 * @param {{ id: string, title: string }} video
 * @param {Record<string, any>} playlists
 */
export function openPlaylistEditor(video, playlists) {
    _currentVideoId = video.id;
    _currentTitle   = video.title || video.id;
    _playlists      = playlists;

    subtitle.textContent = _currentTitle;
    searchInput.value = "";
    searchClear.classList.add("hidden");

    renderRows("");

    overlay.classList.add("show");
    requestAnimationFrame(() => searchInput.focus());
}

export function closeEditor() {
    overlay.classList.remove("show");
}

/** Перерисовать список с фильтром поиска */
function renderRows(query) {
    listEl.innerHTML = "";

    const q = query.toLowerCase();
    const entries = Object.entries(_playlists).filter(([name]) =>
        !q || name.toLowerCase().includes(q)
    );

    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = query ? "Ничего не найдено" : "Нет плейлистов";
        listEl.appendChild(empty);
        return;
    }

    for (const [name, data] of entries) {
        listEl.appendChild(buildRow(name, data));
    }
}

/** Собрать DOM-строку одного плейлиста */
function buildRow(name, data) {
    const isChecked  = !!data.videos?.[_currentVideoId];
    const isReadonly = READONLY_PLAYLISTS.includes(name);
    const count      = Object.keys(data.videos || {}).length;

    const row = document.createElement("div");
    row.className = [
        "pl-row",
        isChecked  ? "pl-row--checked"  : "",
        isReadonly ? "pl-row--readonly" : "",
    ].filter(Boolean).join(" ");

    // Иконка (первая буква или эмодзи)
    const icon = document.createElement("div");
    icon.className = "pl-row-icon";
    icon.textContent = emojiForPlaylist(name);

    // Текст
    const text = document.createElement("div");
    text.className = "pl-row-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-row-name";
    nameEl.textContent = name;

    const countEl = document.createElement("div");
    countEl.className = "pl-row-count";
    countEl.textContent = `${count} видео`;

    text.appendChild(nameEl);
    text.appendChild(countEl);

    // Чекбокс-кружок
    const check = document.createElement("div");
    check.className = "pl-row-check";

    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(check);

    if (isReadonly) {
        row.title = "Этот плейлист нельзя редактировать";
        return row;
    }

    // Клик = мгновенное переключение
    row.addEventListener("click", () => handleToggle(row, name, data, countEl));

    return row;
}

/** Мгновенное добавление/удаление без перерисовки всего списка */
async function handleToggle(row, name, data, countEl) {
    const wasChecked = row.classList.contains("pl-row--checked");
    const add        = !wasChecked;

    // Оптимистичное обновление UI — сразу
    row.classList.toggle("pl-row--checked", add);
    data.videos = data.videos || {};

    if (add) {
        data.videos[_currentVideoId] = { title: _currentTitle };
    } else {
        delete data.videos[_currentVideoId];
    }

    const newCount = Object.keys(data.videos).length;
    countEl.textContent = `${newCount} видео`;

    showToast(add
        ? `<span class="pl-toast-accent">+</span> Добавлено в «${name}»`
        : `Удалено из «${name}»`
    );

    // Запрос к серверу в фоне
    try {
        await _onToggle(name, add);
    } catch (err) {
        // Откат UI при ошибке
        row.classList.toggle("pl-row--checked", wasChecked);
        if (wasChecked) {
            data.videos[_currentVideoId] = { title: _currentTitle };
        } else {
            delete data.videos[_currentVideoId];
        }
        countEl.textContent = `${Object.keys(data.videos).length} видео`;
        showToast("⚠ Ошибка сохранения");
        console.error("Playlist toggle error:", err);
    }
}

/** Показать тост-уведомление снизу */
let _toastTimer = null;
function showToast(html) {
    toast.innerHTML = html;
    toast.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

/** Подобрать эмодзи по имени плейлиста */
function emojiForPlaylist(name) {
    const map = {
        bookmarks: "🔖",
        liked:     "❤️",
        favorites: "⭐",
        watch:     "👁",
        music:     "🎵",
        anime:     "✨",
        funny:     "😂",
        art:       "🎨",
        nature:    "🌿",
        games:     "🎮",
        sport:     "⚡",
    };
    const lower = name.toLowerCase();
    for (const [key, emoji] of Object.entries(map)) {
        if (lower.includes(key)) return emoji;
    }
    return name[0]?.toUpperCase() || "📋";
}

// Синхронизация: при смене видео обновить subtitle (если панель открыта)
export function syncEditorToVideo(video) {
    if (!overlay.classList.contains("show")) return;
    openPlaylistEditor(video, _playlists);
}
