// ui.js — весь рендеринг UI.

// ─── Playlist Selector (Pinterest-style panel) ────────────────────────────────

const selectorOverlay = document.getElementById("playlistSelectorOverlay");
const selectorPanel = document.getElementById("playlistSelectorPanel");
const selectorClose = document.getElementById("plSelectorClose");
const selectorSearch = document.getElementById("plSelectorSearch");
const selectorClear = document.getElementById("plSelectorClear");
const selectorList = document.getElementById("plSelectorList");
const selectorNewBtn = document.getElementById("plSelectorNewBtn");
const triggerBtn = document.getElementById("playlistTriggerBtn");
const triggerLabel = document.getElementById("playlistTriggerLabel");

const READONLY_SELECTOR = ["bookmarks", "liked"];

let _selectorPlaylists = {};
let _selectorSelected = null;
let _onSelectPlaylist = null;
let _onCreateFromSelector = null;
let _onDeletePlaylist = null;
let _onRenamePlaylist = null;
let _getSelectorPlaylists = null;

export function initPlaylistSelector({ getPlaylists, onSelect, onCreate, onDelete, onRename }) {
    _onSelectPlaylist = onSelect;
    _onCreateFromSelector = onCreate;
    _onDeletePlaylist = onDelete;
    _onRenamePlaylist = onRename;
    _getSelectorPlaylists = getPlaylists;

    triggerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _selectorPlaylists = _getSelectorPlaylists();
        selectorSearch.value = "";
        selectorClear.classList.add("hidden");
        renderSelectorRows("");
        openSelector();
    });

    selectorClose.addEventListener("click", closeSelector);

    selectorOverlay.addEventListener("click", (e) => {
        if (!selectorPanel.contains(e.target)) closeSelector();
    });

    selectorSearch.addEventListener("input", () => {
        const q = selectorSearch.value.trim();
        selectorClear.classList.toggle("hidden", !q);
        renderSelectorRows(q);
    });

    selectorClear.addEventListener("click", () => {
        selectorSearch.value = "";
        selectorClear.classList.add("hidden");
        selectorSearch.focus();
        renderSelectorRows("");
    });

    selectorNewBtn.addEventListener("click", async () => {
        if (!_onCreateFromSelector) return;
        const name = await _onCreateFromSelector();
        if (name) {
            _selectorPlaylists = _getSelectorPlaylists();
            renderSelectorRows(selectorSearch.value.trim());
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && selectorOverlay.classList.contains("show")) closeSelector();
    });
}

function openSelector() {
    // Позиционируем под кнопкой-триггером
    const rect = triggerBtn.getBoundingClientRect();
    selectorPanel.style.top = (rect.bottom + 8) + "px";
    selectorPanel.style.left = rect.left + "px";
    selectorPanel.style.transform = "none"; // сбрасываем translateY(-50%) из базового стиля

    selectorOverlay.classList.add("show");
    requestAnimationFrame(() => selectorSearch.focus());
}

function closeSelector() {
    selectorOverlay.classList.remove("show");
}

function renderSelectorRows(query) {
    selectorList.innerHTML = "";
    const q = query.toLowerCase();
    const entries = Object.entries(_selectorPlaylists).filter(
        ([name]) => !q || name.toLowerCase().includes(q)
    );

    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = query ? "Ничего не найдено" : "Нет плейлистов";
        selectorList.appendChild(empty);
        return;
    }

    for (const [name, data] of entries) {
        selectorList.appendChild(buildSelectorRow(name, data));
    }
}

function buildSelectorRow(name, data) {
    const count = Object.keys(data.videos || {}).length;
    const isActive = name === _selectorSelected;
    const isRO = READONLY_SELECTOR.includes(name);

    const row = document.createElement("div");
    row.className = "pl-row" + (isActive ? " pl-row--active" : "");

    const icon = document.createElement("div");
    icon.className = "pl-row-icon";
    icon.textContent = emojiForPlaylist(name);

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

    // Галочка для активного
    const check = document.createElement("div");
    check.className = "pl-row-check";

    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(check);

    // Клик по основной части строки — выбрать плейлист
    const selectArea = [icon, text, check];
    selectArea.forEach(el => el.addEventListener("click", (e) => {
        e.stopPropagation();
        _selectorSelected = name;
        closeSelector();
        setPlaylistTriggerLabel(name);
        _onSelectPlaylist(name);
    }));
    row.addEventListener("click", (e) => {
        // fallback если клик вне кнопок
        if (!e.target.closest(".pl-row-actions")) {
            _selectorSelected = name;
            closeSelector();
            setPlaylistTriggerLabel(name);
            _onSelectPlaylist(name);
        }
    });

    // Кнопки управления — только для не-readonly
    if (!isRO) {
        const actions = document.createElement("div");
        actions.className = "pl-row-actions";

        // Кнопка переименования
        const renameBtn = document.createElement("button");
        renameBtn.className = "pl-row-action-btn pl-row-rename-btn";
        renameBtn.title = "Переименовать";
        renameBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.757l8.61-8.61z" stroke="currentColor" stroke-width="1.2"/></svg>`;
        renameBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            startInlineRename(row, name, nameEl, countEl);
        });

        // Кнопка удаления
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "pl-row-action-btn pl-row-delete-btn";
        deleteBtn.title = "Удалить плейлист";
        deleteBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M2 4h12M5 4V2.5A.5.5 0 0 1 5.5 2h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.6A.5.5 0 0 0 4.3 14h7.4a.5.5 0 0 0 .5-.4L13 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
        deleteBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await handleDeletePlaylist(name, row);
        });

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        row.appendChild(actions);
    }

    return row;
}

function startInlineRename(row, oldName, nameEl, countEl) {
    row.classList.add("pl-row--editing");

    const input = document.createElement("input");
    input.className = "pl-row-rename-input";
    input.value = oldName;
    input.maxLength = 80;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false; // ← гарантируем однократное выполнение

    const cancel = () => {
        if (committed) return;
        committed = true;
        input.replaceWith(nameEl);
        row.classList.remove("pl-row--editing");
    };

    const commit = async () => {
        if (committed) return;
        committed = true;

        const newName = input.value.trim();
        input.replaceWith(nameEl);
        row.classList.remove("pl-row--editing");

        if (!newName || newName === oldName) return;

        if (_selectorPlaylists[newName]) {
            showToast("⚠ Плейлист с таким именем уже существует");
            return;
        }

        try {
            await _onRenamePlaylist(oldName, newName);

            if (_selectorSelected === oldName) {
                _selectorSelected = newName;
                setPlaylistTriggerLabel(newName);
            }

            nameEl.textContent = newName;
            showToast(`Плейлист переименован в «${newName}»`);
            renderSelectorRows(selectorSearch.value.trim());
        } catch (err) {
            showToast("⚠ Ошибка переименования");
            console.error("Rename error:", err);
        }
    };

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
    });
    input.addEventListener("blur", commit);
}

async function handleDeletePlaylist(name, row) {
    const count = Object.keys(_selectorPlaylists[name]?.videos || {}).length;
    const msg = count > 0
        ? `Удалить плейлист «${name}»?\nВ нём ${count} видео. Видеофайлы останутся.`
        : `Удалить плейлист «${name}»?`;
    if (!confirm(msg)) return;

    try {
        await _onDeletePlaylist(name);
        delete _selectorPlaylists[name];
        row.remove();

        // Если удалили активный — сбросить метку
        if (_selectorSelected === name) {
            _selectorSelected = null;
            setPlaylistTriggerLabel("Playlist");
        }

        showToast(`Плейлист «${name}» удалён`);

        // Если список стал пустым — показать заглушку
        if (!Object.keys(_selectorPlaylists).length) {
            renderSelectorRows(selectorSearch.value.trim());
        }
    } catch (err) {
        showToast("⚠ Ошибка удаления");
        console.error("Delete error:", err);
    }
}

export function setPlaylistTriggerLabel(name) {
    triggerLabel.textContent = name;
    _selectorSelected = name;
}

// ─── Video Info ───────────────────────────────────────────────────────────────

const videoTitleLabel = document.getElementById("videoTitleLabel");
const videoIndexInput = document.getElementById("videoIndexInput");
const videoTotal = document.getElementById("videoTotal");

export function updateVideoInfo(index, title, total) {
    videoTitleLabel.textContent = title || "—";
    videoIndexInput.value = index + 1;
    videoTotal.textContent = `/ ${total}`;
}

// ─── Volume Slider ────────────────────────────────────────────────────────────

const volumeSlider = document.getElementById("volumeSlider");

export function initVolumeSlider(onChange) {
    const update = (value) => {
        volumeSlider.value = value;
        volumeSlider.style.setProperty("--value", value + "%");
        onChange(value);
    };
    volumeSlider.addEventListener("input", (e) => update(e.target.value));
    update(volumeSlider.value);

    return (value) => {
        volumeSlider.value = value;
        volumeSlider.style.setProperty("--value", value + "%");
    };
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

const sortTypeGroup = document.getElementById("sortTypeGroup");
const sortDirectionBtn = document.getElementById("sortDirectionBtn");
const seedInput = document.getElementById("seedInput");

const DEFAULT_SEED = 42;

export function initSortBar(onChange) {
    let sortType = "order";
    let sortDirection = "asc";

    // Гарантируем дефолтный seed
    if (!seedInput.value) seedInput.value = DEFAULT_SEED;

    const notify = () => onChange(sortType, sortDirection, parseInt(seedInput.value) || DEFAULT_SEED);

    sortTypeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        [...sortTypeGroup.children].forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        sortType = btn.dataset.type;

        const isRandom = sortType === "random";
        seedInput.classList.toggle("hidden", !isRandom);
        // Кнопка направления не нужна для random
        sortDirectionBtn.classList.toggle("hidden", isRandom);

        notify();
    });

    sortDirectionBtn.addEventListener("click", () => {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
        sortDirectionBtn.textContent = sortDirection === "asc" ? "↑" : "↓";
        notify();
    });

    seedInput.addEventListener("change", () => {
        if (!seedInput.value || parseInt(seedInput.value) < 1) seedInput.value = DEFAULT_SEED;
        notify();
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// PLAYLIST EDITOR — Pinterest-style (add/remove video from playlists)
// ═════════════════════════════════════════════════════════════════════════════

const READONLY_PLAYLISTS = ["bookmarks", "liked"];

const editorOverlay = document.getElementById("playlistEditorOverlay");
const editorPanel = document.getElementById("playlistEditorPanel");
const editorSubtitle = document.getElementById("plEditorSubtitle");
const editorClose = document.getElementById("plEditorClose");
const editorSearch = document.getElementById("plSearchInput");
const editorClear = document.getElementById("plSearchClear");
const editorList = document.getElementById("plEditorList");
const editorNewBtn = document.getElementById("plNewBtn");

const toast = document.createElement("div");
toast.className = "pl-toast";
document.body.appendChild(toast);

let _playlists = {};
let _currentVideoId = null;
let _currentTitle = "";
let _onToggle = null;
let _onCreatePlaylist = null;

export function initPlaylistEditor({ getPlaylists, onToggle, onCreatePlaylist }) {
    _onToggle = onToggle;
    _onCreatePlaylist = onCreatePlaylist;

    editorClose.addEventListener("click", closeEditor);

    editorOverlay.addEventListener("click", (e) => {
        if (!editorPanel.contains(e.target)) closeEditor();
    });

    editorSearch.addEventListener("input", () => {
        const q = editorSearch.value.trim();
        editorClear.classList.toggle("hidden", !q);
        renderEditorRows(q);
    });

    editorClear.addEventListener("click", () => {
        editorSearch.value = "";
        editorClear.classList.add("hidden");
        editorSearch.focus();
        renderEditorRows("");
    });

    editorNewBtn.addEventListener("click", async () => {
        if (!_onCreatePlaylist) return;
        const name = await _onCreatePlaylist();
        if (name) {
            _playlists = getPlaylists();
            renderEditorRows(editorSearch.value.trim());
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && editorOverlay.classList.contains("show")) closeEditor();
    });
}

export function openPlaylistEditor(video, playlists) {
    _currentVideoId = video.id;
    _currentTitle = video.title || video.id;
    _playlists = playlists;

    editorSubtitle.textContent = _currentTitle;
    editorSearch.value = "";
    editorClear.classList.add("hidden");
    renderEditorRows("");

    editorOverlay.classList.add("show");
    requestAnimationFrame(() => editorSearch.focus());
}

export function closeEditor() {
    editorOverlay.classList.remove("show");
}

function renderEditorRows(query) {
    editorList.innerHTML = "";
    const q = query.toLowerCase();
    const entries = Object.entries(_playlists).filter(
        ([name]) => !q || name.toLowerCase().includes(q)
    );

    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = query ? "Ничего не найдено" : "Нет плейлистов";
        editorList.appendChild(empty);
        return;
    }

    for (const [name, data] of entries) {
        editorList.appendChild(buildEditorRow(name, data));
    }
}

function buildEditorRow(name, data) {
    const isChecked = !!data.videos?.[_currentVideoId];
    const isReadonly = READONLY_PLAYLISTS.includes(name);
    const count = Object.keys(data.videos || {}).length;

    const row = document.createElement("div");
    row.className = ["pl-row",
        isChecked ? "pl-row--checked" : "",
        isReadonly ? "pl-row--readonly" : "",
    ].filter(Boolean).join(" ");

    const icon = document.createElement("div");
    icon.className = "pl-row-icon";
    icon.textContent = emojiForPlaylist(name);

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

    const check = document.createElement("div");
    check.className = "pl-row-check";

    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(check);

    if (!isReadonly) {
        row.addEventListener("click", () => handleToggle(row, name, data, countEl));
    }
    return row;
}

async function handleToggle(row, name, data, countEl) {
    const wasChecked = row.classList.contains("pl-row--checked");
    const add = !wasChecked;

    row.classList.toggle("pl-row--checked", add);
    data.videos = data.videos || {};

    if (add) {
        data.videos[_currentVideoId] = { title: _currentTitle };
    } else {
        delete data.videos[_currentVideoId];
    }

    countEl.textContent = `${Object.keys(data.videos).length} видео`;
    showToast(add
        ? `<span class="pl-toast-accent">+</span> Добавлено в «${name}»`
        : `Удалено из «${name}»`
    );

    try {
        await _onToggle(name, add);
    } catch (err) {
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

let _toastTimer = null;
function showToast(html) {
    toast.innerHTML = html;
    toast.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

export function syncEditorToVideo(video) {
    if (!editorOverlay.classList.contains("show")) return;
    openPlaylistEditor(video, _playlists);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function emojiForPlaylist(name) {
    const map = {
        bookmarks: "🔖", liked: "❤️", favorites: "⭐", watch: "👁",
        music: "🎵", anime: "✨", funny: "😂", art: "🎨",
        nature: "🌿", games: "🎮", sport: "⚡",
    };
    const lower = name.toLowerCase();
    for (const [key, emoji] of Object.entries(map)) {
        if (lower.includes(key)) return emoji;
    }
    return [...name][0] || "📋";
}
