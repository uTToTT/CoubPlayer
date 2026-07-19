// ui.js — весь рендеринг UI.
import { getRecentPlaylists, addRecentPlaylist, getRecentTags, addRecentTag } from "./state.js";















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

export function initVolumeSlider(onChange, initialValue = 50) {
    const update = (value) => {
        volumeSlider.value = value;
        volumeSlider.style.setProperty("--value", value + "%");
        onChange(value);
    };
    volumeSlider.addEventListener("input", (e) => {
        update(e.target.value);
        volumeSlider.blur()
    });
    update(initialValue);

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

export function initSortBar(onChange, initial = {}) {
    let sortType = initial.sortType ?? "order";
    let sortDirection = initial.sortDirection ?? "asc";

    seedInput.value = initial.randomSeed ?? DEFAULT_SEED;

    const activeBtn = sortTypeGroup.querySelector(`[data-type="${sortType}"]`);
    if (activeBtn) {
        [...sortTypeGroup.children].forEach(b => b.classList.remove("active"));
        activeBtn.classList.add("active");
    }

    sortDirectionBtn.textContent = sortDirection === "asc" ? "↑" : "↓";

    const random = sortType === "random";
    seedInput.classList.toggle("hidden", !random);
    sortDirectionBtn.classList.toggle("hidden", random);

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

const READONLY_PLAYLISTS = ["bookmarks", "liked", "Все"];

const editorOverlay = document.getElementById("playlistEditorOverlay");
const editorPanel = document.getElementById("playlistEditorPanel");
const editorSubtitle = document.getElementById("plEditorSubtitle");
const editorClose = document.getElementById("plEditorClose");
const editorSearch = document.getElementById("plSearchInput");
const editorClear = document.getElementById("plSearchClear");
const editorList = document.getElementById("plEditorList");
const editorNewBtn = document.getElementById("plNewBtn");
const videoTagsRecent = document.getElementById("videoTagsRecent");

const toast = document.createElement("div");
toast.className = "pl-toast";
document.body.appendChild(toast);

const NAV_EXEMPT_SELECTORS = [
    "#prev", "#next", "#restart", "#fullscreen",
    "#videoIndexWrapper", ".volume-slider", "#copyLinkBtn",
];

function isNavExempt(target) {
    return NAV_EXEMPT_SELECTORS.some((sel) => target.closest(sel));
}

let _playlists = {};
let _currentVideoId = null;
let _currentTitle = "";
let _onToggle = null;
let _onCreatePlaylist = null;

export function initPlaylistEditor({ getPlaylists, onToggle, onCreatePlaylist }) {
    _onToggle = onToggle;
    _onCreatePlaylist = onCreatePlaylist;

    editorClose.addEventListener("click", closeEditor);

    // editorOverlay.addEventListener("click", (e) => {
    //     if (!editorPanel.contains(e.target)) closeEditor();
    // });

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



    document.addEventListener("click", (e) => {
        if (editorOverlay.classList.contains("show")
            && !editorPanel.contains(e.target)
            && !isNavExempt(e.target)) {
            closeEditor();
        }
        // if (selectorOverlay.classList.contains("show")
        //     && !selectorPanel.contains(e.target)
        //     && !isNavExempt(e.target)) {
        //     closeSelector();
        // }
    });
}

export function openPlaylistEditor(video, playlists) {
    const wasOpen = editorOverlay.classList.contains("show");

    _currentVideoId = video.id;
    _currentTitle = video.title || video.id;
    _playlists = playlists;

    editorSubtitle.textContent = _currentTitle;

    // Поиск сбрасываем только при настоящем открытии панели (была закрыта).
    // Если панель уже была открыта (например, просто сменилось видео —
    // вызов пришёл из syncEditorToVideo), сохраняем то, что ввёл пользователь.
    if (!wasOpen) {
        editorSearch.value = "";
        editorClear.classList.add("hidden");
    }

    renderEditorRows(editorSearch.value.trim());

    editorOverlay.classList.add("show");

    if (!wasOpen) {
        requestAnimationFrame(() => editorSearch.focus());
    }
}

export function closeEditor() {
    editorOverlay.classList.remove("show");
    // Очищаем поиск именно при закрытии — по требованию.
    editorSearch.value = "";
    editorClear.classList.add("hidden");
}

export function togglePlaylistEditor(video, playlists) {
    console.log("toggle, show =", editorOverlay.classList.contains("show"));
    if (editorOverlay.classList.contains("show")) {
        closeEditor();
    } else {
        openPlaylistEditor(video, playlists);
    }
}

async function renderEditorRows(query) {
    editorList.innerHTML = "";
    const q = query.toLowerCase();
    let entries = Object.entries(_playlists).filter(
        ([name]) => !q || name.toLowerCase().includes(q)
    );

    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = query ? "Ничего не найдено" : "Нет плейлистов";
        editorList.appendChild(empty);
        return;
    }

    // Без активного поиска — сначала недавно использованные плейлисты
    if (!q) {
        const recentNames = getRecentPlaylists().filter((n) => _playlists[n]);
        const recentSet = new Set(recentNames);
        const recentEntries = recentNames.map((name) => [name, _playlists[name]]);
        const restEntries = entries.filter(([name]) => !recentSet.has(name));

        if (recentEntries.length) {
            const label = document.createElement("div");
            label.className = "pl-section-label";
            label.textContent = "Недавние";
            editorList.appendChild(label);
            for (const [name, data] of recentEntries) {
                editorList.appendChild(await buildEditorRow(name, data));
            }
            if (restEntries.length) {
                const label2 = document.createElement("div");
                label2.className = "pl-section-label";
                label2.textContent = "Все плейлисты";
                editorList.appendChild(label2);
            }
        }
        entries = restEntries;
    }

    for (const [name, data] of entries) {
        editorList.appendChild(await buildEditorRow(name, data));
    }
}

async function buildEditorRow(name, data) {
    const isChecked = !!data.videos?.[_currentVideoId];
    const isReadonly = READONLY_PLAYLISTS.includes(name);
    const count = Object.keys(data.videos || {}).length;

    const row = document.createElement("div");
    row.className = ["pl-row",
        isChecked ? "pl-row--checked" : "",
        isReadonly ? "pl-row--readonly" : "",
    ].filter(Boolean).join(" ");

    const icon = await buildIconEl(name, true);

    // const icon = document.createElement("div");
    // icon.className = "pl-row-icon";
    // icon.textContent = emojiForPlaylist(name);

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
        row.addEventListener("click", (e) => {
            if (e.target.closest(".pl-row-icon--clickable")) return;
            handleToggle(row, name, data, countEl);
        });
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
        addRecentPlaylist(name);
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

// ─── Кастомные иконки плейлистов  ───────────────────────────────


// Таймстамп сессии — гарантирует cache-bust после каждой перезагрузки страницы,
// даже если пользователь не менял иконку в этой сессии
const _sessionCacheBust = Date.now();

const _iconTimestamps = {}; // { [name]: timestamp } — обновляется при загрузке новой иконки

function iconUrlForPlaylist(name) {
    const t = _iconTimestamps[name] || _sessionCacheBust;
    return `/Data/icons/${encodeURIComponent(name)}.webp?t=${t}`;
}

// Проверяем существует ли иконка — через Image onload/onerror
function iconExists(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url + "?t=" + Date.now(); // cache bust
    });
}

function iconPick(name, onDone) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";

    input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const url = await setPlaylistIcon(name, file);
            // Сохраняем timestamp per-playlist чтобы bust работал везде
            _iconTimestamps[name] = Date.now();
            onDone(iconUrlForPlaylist(name));
        } catch {
            showToast("⚠ Не удалось загрузить изображение");
        }
    });

    input.click();
}

async function buildIconEl(name, allowClick) {
    const wrap = document.createElement("div");
    wrap.className = "pl-row-icon";

    const url = iconUrlForPlaylist(name);
    const exists = await iconExists(url);

    const render = (srcUrl) => {
        wrap.innerHTML = "";
        if (srcUrl) {
            const img = document.createElement("img");
            // Берём актуальный URL с timestamp в момент рендера
            img.src = iconUrlForPlaylist(name);
            img.alt = name;
            img.style.cssText =
                "width:100%; height:100%; border-radius:6px; object-fit:cover; display:block;";
            wrap.appendChild(img);
        } else {
            wrap.textContent = emojiForPlaylist(name);
        }
    };

    render(exists ? url : null);

    if (allowClick) {
        wrap.title = "Нажмите чтобы сменить иконку";
        wrap.classList.add("pl-row-icon--clickable");
        wrap.addEventListener("click", (e) => {
            e.stopPropagation();
            iconPick(name, (newUrl) => render(newUrl));
        });
    }

    return wrap;
}

// ─── Video Tags Editor ───────────────────────────────────────────────────────

const editTagsBtn = document.getElementById("editTagsBtn");
const videoTagsOverlay = document.getElementById("videoTagsOverlay");
const videoTagsPanel = document.getElementById("videoTagsPanel");
const videoTagsClose = document.getElementById("videoTagsClose");
const videoTagsSubtitle = document.getElementById("videoTagsSubtitle");
const videoTagsChips = document.getElementById("videoTagsChips");
const videoTagsInput = document.getElementById("videoTagsInput");
const videoTagsAddBtn = document.getElementById("videoTagsAddBtn");
const allTagsDatalist = document.getElementById("allTagsDatalist");

let _tagsVideo = null;
let _tagsCurrent = [];
let _onGetCoubTags = null;
let _onAddTag = null;
let _onRemoveTag = null;
let _onTagsChanged = null;

export function initVideoTagsEditor({ getCoubTags, addTag, removeTag, getAllTags, onTagsChanged }) {
    _onGetCoubTags = getCoubTags;
    _onAddTag = addTag;
    _onRemoveTag = removeTag;
    _onTagsChanged = onTagsChanged;

    refreshTagsDatalist(getAllTags());

    editTagsBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!_tagsVideo) {
            showToast("⚠ Нет текущего видео");
            return;
        }
        refreshTagsDatalist(getAllTags());
        videoTagsOverlay.classList.add("show");
        await loadTagsForCurrentVideo();
        requestAnimationFrame(() => videoTagsInput.focus());
    });

    videoTagsClose.addEventListener("click", () => videoTagsOverlay.classList.remove("show"));

    videoTagsAddBtn.addEventListener("click", commitAddTag);
    videoTagsInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            commitAddTag();
        }
        e.stopPropagation();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && videoTagsOverlay.classList.contains("show")) {
            videoTagsOverlay.classList.remove("show");
        }
    });

    document.addEventListener("click", (e) => {
        if (
            videoTagsOverlay.classList.contains("show") &&
            !videoTagsPanel.contains(e.target) &&
            !e.target.closest("#editTagsBtn") &&
            !isNavExempt(e.target)          // ← добавить эту строку
        ) {
            videoTagsOverlay.classList.remove("show");
        }
    });
}

export function setVideoTagsTarget(video) {
    _tagsVideo = video ? { id: video.id, title: video.title } : null;
    if (videoTagsOverlay.classList.contains("show")) loadTagsForCurrentVideo();
}

export function refreshTagsDatalist(allTags) {
    allTagsDatalist.innerHTML = "";
    for (const { tag } of allTags) {
        const opt = document.createElement("option");
        opt.value = tag;
        allTagsDatalist.appendChild(opt);
    }
}

async function loadTagsForCurrentVideo() {
    if (!_tagsVideo) return;
    videoTagsSubtitle.textContent = _tagsVideo.title || _tagsVideo.id;
    videoTagsChips.innerHTML = `<div class="pl-empty">Загрузка…</div>`;
    videoTagsRecent.innerHTML = "";
    try {
        const res = await _onGetCoubTags(_tagsVideo.id);
        const list = Array.isArray(res) ? res : res.tags || [];
        _tagsCurrent = list.map((t) => (typeof t === "string" ? t : t.tag));
        renderTagChips();
        renderRecentTagSuggestions();
    } catch (err) {
        videoTagsChips.innerHTML = `<div class="pl-empty">Ошибка загрузки тегов</div>`;
        console.error("Tags load error:", err);
    }
}

function renderRecentTagSuggestions() {
    videoTagsRecent.innerHTML = "";
    const recent = getRecentTags().filter((t) => !_tagsCurrent.includes(t));
    if (!recent.length) return;

    const label = document.createElement("span");
    label.className = "video-tags-recent-label";
    label.textContent = "Недавние:";
    videoTagsRecent.appendChild(label);

    for (const tag of recent) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tag-chip tag-chip--suggest";
        chip.textContent = tag;
        chip.addEventListener("click", () => quickAddTag(tag));
        videoTagsRecent.appendChild(chip);
    }
}

async function quickAddTag(tag) {
    if (!tag || !_tagsVideo || _tagsCurrent.includes(tag)) return;
    _tagsCurrent.push(tag);
    renderTagChips();
    renderRecentTagSuggestions();

    try {
        await _onAddTag(_tagsVideo.id, tag);
        addRecentTag(tag);
        _onTagsChanged?.();
    } catch (err) {
        _tagsCurrent = _tagsCurrent.filter((t) => t !== tag);
        renderTagChips();
        renderRecentTagSuggestions();
        showToast("⚠ Не удалось добавить тег");
        console.error("Add tag error:", err);
    }
}

function renderTagChips() {
    videoTagsChips.innerHTML = "";
    if (!_tagsCurrent.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = "Тегов пока нет";
        videoTagsChips.appendChild(empty);
        return;
    }
    for (const tag of _tagsCurrent) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";

        const label = document.createElement("span");
        label.textContent = tag;

        const remove = document.createElement("button");
        remove.className = "tag-chip-remove";
        remove.textContent = "✕";
        remove.title = "Удалить тег";
        remove.addEventListener("click", () => removeTagChip(tag, chip));

        chip.appendChild(label);
        chip.appendChild(remove);
        videoTagsChips.appendChild(chip);
    }
}

async function commitAddTag() {
    const tag = videoTagsInput.value.trim();
    if (!tag || !_tagsVideo) return;
    if (_tagsCurrent.includes(tag)) {
        showToast("⚠ Тег уже добавлен");
        videoTagsInput.value = "";
        return;
    }

    videoTagsInput.value = "";
    _tagsCurrent.push(tag);
    renderTagChips();
    renderRecentTagSuggestions();

    try {
        await _onAddTag(_tagsVideo.id, tag);
        addRecentTag(tag);
        _onTagsChanged?.();
    } catch (err) {
        _tagsCurrent = _tagsCurrent.filter((t) => t !== tag);
        renderTagChips();
        renderRecentTagSuggestions();
        showToast("⚠ Не удалось добавить тег");
        console.error("Add tag error:", err);
    }
}

async function removeTagChip(tag, chipEl) {
    const prev = [..._tagsCurrent];
    _tagsCurrent = _tagsCurrent.filter((t) => t !== tag);
    chipEl.remove();

    try {
        await _onRemoveTag(_tagsVideo.id, tag);
        _onTagsChanged?.();
        renderRecentTagSuggestions();
    } catch (err) {
        _tagsCurrent = prev;
        renderTagChips();
        showToast("⚠ Не удалось удалить тег");
        console.error("Remove tag error:", err);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// SORTING PANEL — Плейлисты + Теги в одном окне (табы)
// ═════════════════════════════════════════════════════════════════════════════

import { setPlaylistIcon } from "./api.js";

const sortingOverlay = document.getElementById("sortingOverlay");
const sortingPanel = document.getElementById("sortingPanel");
const sortingClose = document.getElementById("sortingClose");
const sortingTitle = document.getElementById("sortingTitle");
const sortingSubtitle = document.getElementById("sortingSubtitle");
const sortingTabs = document.getElementById("sortingTabs");
const sortingSearch = document.getElementById("sortingSearch");
const sortingSearchClear = document.getElementById("sortingSearchClear");
const tagFilterModeGroup = document.getElementById("tagFilterModeGroup");

const plSelectorList = document.getElementById("plSelectorList");
const tagFilterListEl = document.getElementById("tagFilterList");
const sortingFooterPlaylists = document.getElementById("sortingFooterPlaylists");
const sortingFooterTags = document.getElementById("sortingFooterTags");
const plSelectorNewBtn = document.getElementById("plSelectorNewBtn");
const tagFilterClearBtn = document.getElementById("tagFilterClearBtn");

const playlistTriggerBtn = document.getElementById("playlistTriggerBtn");
const playlistTriggerLabel = document.getElementById("playlistTriggerLabel");

const INVALID_CHARS = /[\/\\:*?"<>|]/;
const SANITIZE_CHARS = /[\/\\:*?"<>|]/g;
const READONLY_SELECTOR = ["bookmarks", "liked", "Все"];

// state — playlists
let _selectorPlaylists = {};
let _selectorSelected = null;
let _onSelectPlaylist = null;
let _onCreateFromSelector = null;
let _onDeletePlaylist = null;
let _onRenamePlaylist = null;
let _getSelectorPlaylists = null;

// state — tags
let _allTagsCache = [];
let _activeTags = [];
let _tagMode = "any";
let _onTagFilterChange = null;
let _getAllTags = null;
let _getActiveTags = null;
let _getTagMode = null;

let _activeSortingTab = "playlists";

export function initSortingPanel({
    // playlists
    getPlaylists, onSelect, onCreate, onDelete, onRename,
    // tags
    getAllTags, getActiveTagFilter, getTagFilterMode, onTagFilterChange,
}) {
    _onSelectPlaylist = onSelect;
    _onCreateFromSelector = onCreate;
    _onDeletePlaylist = onDelete;
    _onRenamePlaylist = onRename;
    _getSelectorPlaylists = getPlaylists;

    _getAllTags = getAllTags;
    _getActiveTags = getActiveTagFilter;
    _getTagMode = getTagFilterMode;
    _onTagFilterChange = onTagFilterChange;

    // Триггер — открывает окно (вкладка "Плейлисты" по умолчанию;
    // на "Теги" переключаются уже внутри окна через табы)
    playlistTriggerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openSortingPanel("playlists");
    });

    sortingClose.addEventListener("click", closeSortingPanel);

    sortingTabs.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-tab]");
        if (!btn) return;
        switchSortingTab(btn.dataset.tab);
    });

    sortingSearch.addEventListener("input", () => {
        const q = sortingSearch.value.trim();
        sortingSearchClear.classList.toggle("hidden", !q);
        renderActiveTab(q);
    });

    sortingSearchClear.addEventListener("click", () => {
        sortingSearch.value = "";
        sortingSearchClear.classList.add("hidden");
        sortingSearch.focus();
        renderActiveTab("");
    });

    tagFilterModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-mode]");
        if (!btn) return;
        _tagMode = btn.dataset.mode;
        syncTagModeButtons();
        notifyTagFilterChange();
    });

    tagFilterClearBtn.addEventListener("click", () => {
        _activeTags = [];
        renderActiveTab(sortingSearch.value.trim());
        notifyTagFilterChange();
    });

    plSelectorNewBtn.addEventListener("click", async () => {
        if (!_onCreateFromSelector) return;
        const name = await _onCreateFromSelector();
        if (name) {
            _selectorPlaylists = _getSelectorPlaylists();
            renderActiveTab(sortingSearch.value.trim());
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) return;
        if (e.key === "Escape" && sortingOverlay.classList.contains("show")) closeSortingPanel();
    });

    document.addEventListener("click", (e) => {
        if (
            sortingOverlay.classList.contains("show") &&
            !sortingPanel.contains(e.target) &&
            !e.target.closest("#playlistTriggerBtn")
        ) {
            closeSortingPanel();
        }
    });

}

function openSortingPanel(tab) {
    _selectorPlaylists = _getSelectorPlaylists();
    _allTagsCache = _getAllTags();
    _activeTags = [..._getActiveTags()];
    _tagMode = _getTagMode();
    syncTagModeButtons();

    sortingSearch.value = "";
    sortingSearchClear.classList.add("hidden");

    switchSortingTab(tab);
    sortingOverlay.classList.add("show");
    requestAnimationFrame(() => sortingSearch.focus());
}

function closeSortingPanel() {
    sortingOverlay.classList.remove("show");
}

function switchSortingTab(tab) {
    _activeSortingTab = tab;
    const isTags = tab === "tags";

    [...sortingTabs.children].forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

    tagFilterModeGroup.hidden = !isTags;
    plSelectorList.classList.toggle("pl-tab-hidden", isTags);
    tagFilterListEl.classList.toggle("pl-tab-hidden", !isTags);
    sortingFooterPlaylists.classList.toggle("pl-tab-hidden", isTags);
    sortingFooterTags.classList.toggle("pl-tab-hidden", !isTags);

    sortingTitle.textContent = isTags ? "Теги" : "Плейлисты";
    sortingSearch.placeholder = isTags ? "Найти тег…" : "Найти плейлист…";

    sortingSearch.value = "";
    sortingSearchClear.classList.add("hidden");

    updateSortingSubtitle();
    renderActiveTab("");
}

function updateSortingSubtitle() {
    if (_activeSortingTab === "tags") {
        sortingSubtitle.textContent = _activeTags.length
            ? `${_activeTags.length} тег(ов) · ${_tagMode === "any" ? "любой из" : "все сразу"}`
            : "Все видео";
    } else {
        sortingSubtitle.textContent = "Выберите плейлист";
    }
}

function renderActiveTab(query) {
    if (_activeSortingTab === "tags") renderTagFilterRows(query);
    else renderSelectorRows(query);
}

function syncTagModeButtons() {
    [...tagFilterModeGroup.children].forEach((b) =>
        b.classList.toggle("active", b.dataset.mode === _tagMode)
    );
}

// ─── Playlists tab ─────────────────────────────────────────────────────────

async function renderSelectorRows(query) {
    plSelectorList.innerHTML = "";
    const q = query.toLowerCase();
    let entries = Object.entries(_selectorPlaylists).filter(
        ([name]) => !q || name.toLowerCase().includes(q)
    );

    entries = sortPlaylistEntries(entries); // ← добавили

    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = query ? "Ничего не найдено" : "Нет плейлистов";
        plSelectorList.appendChild(empty);
        return;
    }

    for (const [name, data] of entries) {
        plSelectorList.appendChild(await buildSelectorRow(name, data));
    }
}

const PRIORITY_ORDER = ["Все", "bookmarks", "liked"];

function sortPlaylistEntries(entries) {
    return entries.sort(([aName], [bName]) => {
        const aIdx = PRIORITY_ORDER.indexOf(aName);
        const bIdx = PRIORITY_ORDER.indexOf(bName);
        if (aIdx === -1 && bIdx === -1) return 0; // стабильная сортировка сохранит остальной порядок
        if (aIdx === -1) return 1;
        if (bIdx === -1) return -1;
        return aIdx - bIdx;
    });
}

async function buildSelectorRow(name, data) {
    const count = Object.keys(data.videos || {}).length;
    const isActive = name === _selectorSelected;
    const isRO = READONLY_SELECTOR.includes(name);

    const tile = document.createElement("div");
    tile.className = "pl-tile" + (isActive ? " pl-tile--active" : "");

    const thumb = await buildIconEl(name, true);
    thumb.classList.add("pl-tile-thumb");
    tile.appendChild(thumb);

    const text = document.createElement("div");
    text.className = "pl-tile-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-tile-name pl-row-name";
    nameEl.textContent = name;

    const countEl = document.createElement("div");
    countEl.className = "pl-tile-count";
    countEl.textContent = `${count} видео`;

    text.appendChild(nameEl);
    text.appendChild(countEl);
    tile.appendChild(text);

    const check = document.createElement("div");
    check.className = "pl-row-check";
    tile.appendChild(check);

    tile.addEventListener("click", (e) => {
        if (e.target.closest(".pl-row-icon--clickable")) return;
        if (e.target.closest(".pl-row-actions")) return;
        _selectorSelected = name;
        closeSortingPanel();
        setPlaylistTriggerLabel(name);
        _onSelectPlaylist(name);
    });

    if (!isRO) {
        const actions = document.createElement("div");
        actions.className = "pl-row-actions";

        const renameBtn = document.createElement("button");
        renameBtn.className = "pl-row-action-btn pl-row-rename-btn";
        renameBtn.title = "Переименовать";
        renameBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.757l8.61-8.61z" stroke="currentColor" stroke-width="1.2"/></svg>`;
        renameBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            startInlineRename(tile, name, nameEl, countEl);
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "pl-row-action-btn pl-row-delete-btn";
        deleteBtn.title = "Удалить плейлист";
        deleteBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M2 4h12M5 4V2.5A.5.5 0 0 1 5.5 2h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.6A.5.5 0 0 0 4.3 14h7.4a.5.5 0 0 0 .5-.4L13 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
        deleteBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await handleDeletePlaylist(name, tile);
        });

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        tile.appendChild(actions);
    }

    return tile;
}

export async function sanitizeBrokenPlaylists() {
    const playlists = _getSelectorPlaylists();
    const broken = Object.keys(playlists).filter((name) => INVALID_CHARS.test(name));

    if (!broken.length) {
        showToast("✓ Сломанных плейлистов не найдено");
        return;
    }

    let fixed = 0;
    for (const oldName of broken) {
        const newName = oldName.replace(SANITIZE_CHARS, "_").trim();
        const finalName = playlists[newName] && newName !== oldName
            ? newName + "_" + Date.now()
            : newName;

        try {
            await _onRenamePlaylist(oldName, finalName);
            if (_iconTimestamps[oldName]) {
                _iconTimestamps[finalName] = _iconTimestamps[oldName];
                delete _iconTimestamps[oldName];
            }
            if (_selectorSelected === oldName) {
                _selectorSelected = finalName;
                setPlaylistTriggerLabel(finalName);
            }
            fixed++;
        } catch (err) {
            console.error(`Не удалось исправить «${oldName}»:`, err);
        }
    }

    _selectorPlaylists = _getSelectorPlaylists();
    if (sortingOverlay.classList.contains("show") && _activeSortingTab === "playlists") {
        renderSelectorRows(sortingSearch.value.trim());
    }
    showToast(`✓ Исправлено плейлистов: ${fixed} из ${broken.length}`);
}

function startInlineRename(tile, oldName, nameEl, countEl) {
    tile.classList.add("pl-row--editing");

    const input = document.createElement("input");
    input.className = "pl-row-rename-input";
    input.value = oldName;
    input.maxLength = 80;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    const cancel = () => {
        if (committed) return;
        committed = true;
        input.replaceWith(nameEl);
        tile.classList.remove("pl-row--editing");
    };

    const commit = async () => {
        if (committed) return;
        committed = true;

        const newName = input.value.trim();
        input.replaceWith(nameEl);
        tile.classList.remove("pl-row--editing");

        if (!newName || newName === oldName) return;

        if (INVALID_CHARS.test(newName)) {
            showToast('⚠ Недопустимые символы: / \\ : * ? " < > |');
            return;
        }

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
            renderSelectorRows(sortingSearch.value.trim());
        } catch (err) {
            showToast("⚠ Ошибка переименования");
            console.error("Rename error:", err);
        }
    };

    input.addEventListener("input", () => {
        input.classList.toggle("pl-row-rename-input--invalid", INVALID_CHARS.test(input.value));
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
    });
    input.addEventListener("blur", commit);
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
}

async function handleDeletePlaylist(name, tile) {
    const count = Object.keys(_selectorPlaylists[name]?.videos || {}).length;
    const msg = count > 0
        ? `Удалить плейлист «${name}»?\nВ нём ${count} видео. Видеофайлы останутся.`
        : `Удалить плейлист «${name}»?`;
    if (!confirm(msg)) return;

    try {
        await _onDeletePlaylist(name);
        delete _selectorPlaylists[name];
        tile.remove();

        if (_selectorSelected === name) {
            _selectorSelected = null;
            setPlaylistTriggerLabel("Playlist");
        }

        showToast(`Плейлист «${name}» удалён`);

        if (!Object.keys(_selectorPlaylists).length) {
            renderSelectorRows(sortingSearch.value.trim());
        }
    } catch (err) {
        showToast("⚠ Ошибка удаления");
        console.error("Delete error:", err);
    }
}

export function setPlaylistTriggerLabel(name) {
    playlistTriggerLabel.textContent = name;
    _selectorSelected = name;
}

// ─── Tags tab ──────────────────────────────────────────────────────────────

function renderTagFilterRows(query) {
    tagFilterListEl.innerHTML = "";
    const q = query.toLowerCase();
    const filtered = _allTagsCache.filter(({ tag }) => !q || tag.toLowerCase().includes(q));

    if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = "Тегов не найдено";
        tagFilterListEl.appendChild(empty);
        return;
    }

    for (const { tag, count } of filtered) {
        tagFilterListEl.appendChild(buildTagTile(tag, count));
    }
}

function buildTagTile(tag, count) {
    const checked = _activeTags.includes(tag);

    const tile = document.createElement("div");
    tile.className = "pl-tile" + (checked ? " pl-tile--active" : "");

    const thumb = document.createElement("div");
    thumb.className = "pl-row-icon pl-tile-thumb pl-tag-thumb";
    thumb.textContent = "🏷";
    tile.appendChild(thumb);

    const text = document.createElement("div");
    text.className = "pl-tile-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-tile-name";
    nameEl.textContent = tag;

    const countEl = document.createElement("div");
    countEl.className = "pl-tile-count";
    countEl.textContent = `${count} видео`;

    text.appendChild(nameEl);
    text.appendChild(countEl);
    tile.appendChild(text);

    const check = document.createElement("div");
    check.className = "pl-row-check";
    tile.appendChild(check);

    tile.addEventListener("click", () => {
        const idx = _activeTags.indexOf(tag);
        if (idx === -1) _activeTags.push(tag);
        else _activeTags.splice(idx, 1);
        tile.classList.toggle("pl-tile--active");
        notifyTagFilterChange();
    });

    return tile;
}

function notifyTagFilterChange() {
    updateSortingSubtitle();
    _onTagFilterChange?.([..._activeTags], _tagMode);
}

// ─── isAnyPanelOpen — используется main.js для клика-паузы ────────────────

export function isAnyPanelOpen() {
    return (
        editorOverlay.classList.contains("show") ||
        sortingOverlay.classList.contains("show") ||
        videoTagsOverlay.classList.contains("show")
    );
}

// ─── Seek Bar ─────────────────────────────────────────────────────────────

const seekBarTrack = document.getElementById("seekBarTrack");
const seekBarFill = document.getElementById("seekBarFill");
const seekBarThumb = document.getElementById("seekBarThumb");
const seekBarCurrent = document.getElementById("seekBarCurrent");
const seekBarDuration = document.getElementById("seekBarDuration");

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

export function initSeekBar(onSeek) {
    let dragging = false;

    const ratioFromEvent = (e) => {
        const rect = seekBarTrack.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };

    const setVisual = (ratio) => {
        seekBarFill.style.width = `${ratio * 100}%`;
        seekBarThumb.style.left = `${ratio * 100}%`;
    };

    const startDrag = (e) => {
        dragging = true;
        seekBarTrack.classList.add("seek-bar-track--dragging");
        drag(e);
        e.preventDefault();
    };

    const drag = (e) => {
        if (!dragging) return;
        const ratio = ratioFromEvent(e);
        setVisual(ratio);
        onSeek(ratio);
    };

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        seekBarTrack.classList.remove("seek-bar-track--dragging");
        onSeek(ratioFromEvent(e));
    };

    seekBarTrack.addEventListener("mousedown", startDrag);
    seekBarTrack.addEventListener("touchstart", startDrag, { passive: false });
    document.addEventListener("mousemove", drag);
    document.addEventListener("touchmove", drag, { passive: false });
    document.addEventListener("mouseup", endDrag);
    document.addEventListener("touchend", endDrag);

    return {
        isDragging: () => dragging,
        update(current, duration) {
            if (dragging) return;
            const ratio = duration > 0 ? current / duration : 0;
            setVisual(ratio);
            seekBarCurrent.textContent = formatTime(current);
            seekBarDuration.textContent = formatTime(duration);
        },
    };
}