// grid.js — режим просмотра плейлиста плиткой.
//
// Это не модалка, а второй основной вид: тело получает класс view-grid,
// плеерная обвязка (само видео, стрелки, таймлайн, счётчик) прячется,
// сетка занимает её место. Плеер при этом продолжает играть — переключение
// вида не трогает воспроизведение.
//
// Сетка показывает ровно тот список, который загружен в плеер (уже
// отсортированный и отфильтрованный по тегам), поэтому индексы плиток
// совпадают с индексами player.playlist.
//
// Превью — те же самые video.mp4 + audio.mp3, что играет плеер (отдельных
// превьюшек на сервере нет). Чтобы не тянуть сотни файлов разом:
//   • src проставляется только когда плитка попала во вьюпорт (IntersectionObserver)
//     и снимается, когда она из него ушла;
//   • сами плитки рисуются порциями по CHUNK штук по мере скролла;
//   • ролик проигрывается только под курсором, в остальное время стоит на
//     первом кадре (#t=0.1).
//
// Выделение: чекбокс в углу плитки, Ctrl+клик (переключить) и Shift+клик
// (диапазон). Пока что-то выделено, обычный клик тоже переключает выделение,
// а перейти к ролику можно двойным кликом. Над выделенным набором работают
// массовые действия — добавить всё в плейлист или навесить тег.
//
// Порядок роликов меняется перетаскиванием плиток — доступно только когда
// сетка показывает плейлист в его собственном порядке (сортировка Order).

import { showToast, isMadnessPanelOpen } from "./ui.js";
import { composeSettings } from "./randomizer.js";

const TILE_MIN_PX = { s: 140, m: 220, l: 320 };
const CHUNK = 60;
const DRAG_SCROLL_ZONE = 70; // px от края списка, где начинается автоскролл

const gridView = document.getElementById("gridView");
const subtitle = document.getElementById("gridSubtitle");
const search = document.getElementById("gridSearch");
const searchClear = document.getElementById("gridSearchClear");
const list = document.getElementById("gridList");
const sizeGroup = document.getElementById("gridSizeGroup");
const viewModeGroup = document.getElementById("viewModeGroup");

const bulkBar = document.getElementById("gridBulkBar");
const bulkCount = document.getElementById("gridBulkCount");
const bulkAllBtn = document.getElementById("gridBulkAll");
const bulkClearBtn = document.getElementById("gridBulkClear");
const bulkPlaylistBtn = document.getElementById("gridBulkPlaylist");
const bulkTagBtn = document.getElementById("gridBulkTag");
const bulkPresetBtn = document.getElementById("gridBulkPreset");

const popover = document.getElementById("gridBulkPopover");
const popoverTitle = document.getElementById("gridBulkPopoverTitle");
const popoverClose = document.getElementById("gridBulkPopoverClose");
const popoverList = document.getElementById("gridBulkPopoverList");
const popoverInput = document.getElementById("gridBulkInput");
const popoverAddBtn = document.getElementById("gridBulkInputAdd");

// Плейлисты, которыми управляет не пользователь, а синхронизация/само приложение
const BULK_EXCLUDED_PLAYLISTS = ["Все", "bookmarks", "liked"];

let _getItems = () => [];
let _getCurrentIndex = () => -1;
let _getPlaylistName = () => null;
let _onPick = null;
let _onTileSizeChange = null;
let _onViewModeChange = null;
let _getVolume = () => 50;
let _onPreviewActive = null;
let _getPlaylists = () => ({});
let _onCreatePlaylist = null;
let _onBulkAddToPlaylist = null;
let _getAllTags = () => [];
let _onBulkAddTag = null;
let _getPresets = () => [];
let _onBulkApplyPreset = null;
let _getReorderInfo = () => ({ enabled: false, hint: "" });
let _onReorder = null;
let _onPlayerActive = null;
let _onBgPreview = null;

// Снимок плейлиста: [{ item, index }], index — позиция в player.playlist
let _entries = [];
let _filtered = [];
let _entryById = new Map();
let _renderedCount = 0;
let _tileSize = "m";
let _viewMode = "list";

const _selected = new Set(); // ключи записей выделенных роликов
let _anchorPos = null;       // позиция в _filtered для Shift-диапазона
let _bulkMode = null;        // null | "playlist" | "tag"
let _bulkBusy = false;

let _dragTile = null;
let _reorderEnabled = false;

// ─── Звук превью ──────────────────────────────────────────────────────────
// Один общий audio-элемент: одновременно проигрывается только одна плитка.
// Основной плеер на это время приглушается через _onPreviewActive, иначе
// две дорожки играли бы одна поверх другой.

const previewAudio = new Audio();
previewAudio.loop = true;
let _previewVideo = null;

function startPreview(video, item) {
    if (_dragTile) return; // во время перетаскивания превью только мешают
    stopPreview();
    _previewVideo = video;

    if (video.dataset.loaded === "1") video.play().catch(() => { });

    // Фон повторяет тот ролик, который сейчас смотрят
    _onBgPreview?.(video, item);

    if (item.audio) {
        _onPreviewActive?.(true);
        previewAudio.src = item.audio;
        previewAudio.volume = Math.max(0, Math.min(1, _getVolume() / 100));
        previewAudio.currentTime = 0;
        previewAudio.play().catch(() => { });
    }
}

function stopPreview() {
    if (_previewVideo) _onBgPreview?.(null, null);
    if (_previewVideo) {
        _previewVideo.pause();
        try { _previewVideo.currentTime = 0.1; } catch { /* метаданные ещё не готовы */ }
        _previewVideo = null;
    }
    if (previewAudio.hasAttribute("src")) {
        previewAudio.pause();
        previewAudio.removeAttribute("src");
        previewAudio.load(); // отпускаем скачанный mp3
    }
    _onPreviewActive?.(false);
}

// ─── Ленивая загрузка превью ──────────────────────────────────────────────

const mediaObserver = new IntersectionObserver(
    (records) => {
        for (const rec of records) {
            if (rec.isIntersecting) attachMedia(rec.target);
            else detachMedia(rec.target);
        }
    },
    { root: list, rootMargin: "300px 0px" }
);

function attachMedia(video) {
    if (video.dataset.loaded === "1" || !video.dataset.src) return;
    video.dataset.loaded = "1";
    // Фрагмент #t=0.1 заставляет браузер отрисовать первый кадр,
    // не дожидаясь play() — это и есть наша "превьюшка".
    video.src = video.dataset.src + "#t=0.1";
}

function detachMedia(video) {
    if (video.dataset.loaded !== "1") return;
    if (video === _previewVideo) stopPreview();
    video.dataset.loaded = "0";
    video.pause();
    video.classList.remove("is-ready");
    video.removeAttribute("src");
    video.load(); // освобождает буфер декодера
}

/** Сносит все плитки и отпускает связанные с ними видео. */
function clearTiles() {
    stopPreview();
    list.querySelectorAll("video").forEach((v) => {
        detachMedia(v);
        mediaObserver.unobserve(v);
    });
    sentinelObserver.unobserve(sentinel);
    list.innerHTML = "";
    _renderedCount = 0;
}

// ─── Подгрузка следующей порции плиток ────────────────────────────────────

const sentinel = document.createElement("div");
sentinel.className = "coub-grid-sentinel";

const sentinelObserver = new IntersectionObserver(
    (records) => {
        if (records.some((r) => r.isIntersecting)) renderNextChunk();
    },
    { root: list, rootMargin: "400px 0px" }
);

// ─── Init ─────────────────────────────────────────────────────────────────

export function initGridView({
    getItems, getCurrentIndex, getPlaylistName, onPick,
    getTileSize, onTileSizeChange,
    getViewMode, onViewModeChange,
    getVolume, onPreviewActive,
    getPlaylists, onCreatePlaylist, onBulkAddToPlaylist,
    getAllTags, onBulkAddTag,
    getPresets, onBulkApplyPreset,
    getReorderInfo, onReorder,
    onPlayerActive, onBgPreview,
}) {
    _getItems = getItems;
    _getCurrentIndex = getCurrentIndex;
    _getPlaylistName = getPlaylistName;
    _onPick = onPick;
    _onTileSizeChange = onTileSizeChange;
    _onViewModeChange = onViewModeChange;
    _getVolume = getVolume || _getVolume;
    _onPreviewActive = onPreviewActive;
    _getPlaylists = getPlaylists || _getPlaylists;
    _onCreatePlaylist = onCreatePlaylist;
    _onBulkAddToPlaylist = onBulkAddToPlaylist;
    _getAllTags = getAllTags || _getAllTags;
    _onBulkAddTag = onBulkAddTag;
    _getPresets = getPresets || _getPresets;
    _onBulkApplyPreset = onBulkApplyPreset;
    _getReorderInfo = getReorderInfo || _getReorderInfo;
    _onReorder = onReorder;
    _onPlayerActive = onPlayerActive;
    _onBgPreview = onBgPreview;

    setTileSize(getTileSize?.() || "m");

    viewModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-view]");
        if (!btn) return;
        setViewMode(btn.dataset.view);
        btn.blur();
    });

    sizeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-size]");
        if (!btn) return;
        setTileSize(btn.dataset.size);
        _onTileSizeChange?.(btn.dataset.size);
    });

    search.addEventListener("input", () => {
        const q = search.value.trim();
        searchClear.classList.toggle("hidden", !q);
        applyFilter(q);
    });

    searchClear.addEventListener("click", () => {
        search.value = "";
        searchClear.classList.add("hidden");
        search.focus();
        applyFilter("");
    });

    initBulkActions();
    initDragAndDrop();

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) {
            // Из поля поиска сетки Escape должен выпускать наружу
            if (e.key === "Escape" && e.target === search) {
                e.preventDefault();
                search.blur();
            }
            return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        if (e.key === "Escape" && isGridMode()) {
            // Панель «Безумие» закрывает себя сама — не отбираем у неё Escape
            if (isMadnessPanelOpen()) return;
            // Сворачиваем по одному уровню: выпадашка → выделение → вид
            e.preventDefault();
            if (!popover.classList.contains("hidden")) closeBulkPopover();
            else if (_selected.size) clearSelection();
            else setViewMode("list");
            return;
        }

        // code — на случай кириллической раскладки, key — на случай эмуляции
        // клавиатуры без code (некоторые автоматизации)
        if (e.code === "KeyG" || e.key === "g" || e.key === "G") {
            e.preventDefault();
            setViewMode(isGridMode() ? "list" : "grid");
        }
    });

    // Клик мимо выпадашки закрывает её. Кнопки самой панели массовых действий
    // из этого исключены: менять выделение, не закрывая уже открытый список, —
    // нормальный сценарий.
    document.addEventListener("click", (e) => {
        if (popover.classList.contains("hidden")) return;
        if (popover.contains(e.target) || e.target.closest(".grid-bulk-bar")) return;
        closeBulkPopover();
    }, true);

    setViewMode(getViewMode?.() || "list", { silent: true });
}

// ─── Переключение вида ────────────────────────────────────────────────────

export function isGridMode() {
    return _viewMode === "grid";
}

/**
 * Переставляет ползунок громкости между нижней панелью и строкой сетки.
 *
 * Именно переставляет, а не заводит второй: два ползунка пришлось бы
 * синхронизировать, и они бы однажды разошлись. Обработчики висят на самом
 * элементе и переезд переживают.
 *
 * Исходное место запоминаем соседом, а не родителем: в панели ползунок не
 * первый, и возвращать его надо туда же, откуда взяли.
 */
let _volumeHome = null;

function moveVolumeControl(toGrid) {
    const slider = document.getElementById("volumeSlider");
    const slot = document.getElementById("gridVolumeSlot");
    if (!slider || !slot) return;

    if (!_volumeHome) {
        _volumeHome = { parent: slider.parentNode, before: slider.nextSibling };
    }

    if (toGrid) {
        if (slider.parentNode !== slot) slot.appendChild(slider);
    } else if (slider.parentNode === slot) {
        _volumeHome.parent.insertBefore(slider, _volumeHome.before);
    }
}

export function setViewMode(mode, { silent = false } = {}) {
    const next = mode === "grid" ? "grid" : "list";
    const changed = next !== _viewMode;
    _viewMode = next;

    document.body.classList.toggle("view-grid", isGridMode());
    [...viewModeGroup.children].forEach((b) =>
        b.classList.toggle("active", b.dataset.view === _viewMode)
    );

    moveVolumeControl(isGridMode());

    if (isGridMode()) {
        // Режим «плитка» полностью выключает плеер: звучать и крутиться
        // должна только плитка под курсором
        _onPlayerActive?.(false);
        rebuild();
    } else {
        closeBulkPopover();
        clearSelection();
        clearTiles();
        _onPlayerActive?.(true);
    }

    if (changed && !silent) _onViewModeChange?.(_viewMode);
}

/**
 * Пересобрать сетку из текущего плейлиста плеера.
 * Вызывается при смене плейлиста, сортировки и тег-фильтра.
 */
export function refreshGrid() {
    if (!isGridMode()) return;
    rebuild();
}

function rebuild() {
    _entries = (_getItems() || []).map((item, index) => ({ item, index }));
    _entryById = new Map(_entries.map((e) => [e.item.key, e]));

    // Выделение переживает пересборку только для тех роликов, что остались
    for (const id of [..._selected]) if (!_entryById.has(id)) _selected.delete(id);

    const info = _getReorderInfo();
    _reorderEnabled = !!info.enabled;
    list.classList.toggle("coub-grid--reorderable", _reorderEnabled);

    applyFilter(search.value.trim());
    updateBulkBar();
    requestAnimationFrame(scrollActiveIntoView);
}

/** Подсветить плитку текущего ролика (плеер мог переключиться и в фоне). */
export function syncGridToVideo() {
    if (!isGridMode()) return;
    const current = _getCurrentIndex();
    list.querySelectorAll(".coub-tile").forEach((tile) => {
        tile.classList.toggle("coub-tile--active", Number(tile.dataset.index) === current);
    });
}

// ─── Размер плиток ────────────────────────────────────────────────────────

function setTileSize(size) {
    _tileSize = TILE_MIN_PX[size] ? size : "m";
    list.style.setProperty("--coub-tile-min", TILE_MIN_PX[_tileSize] + "px");
    [...sizeGroup.children].forEach((b) =>
        b.classList.toggle("active", b.dataset.size === _tileSize)
    );
}

// ─── Рендер ───────────────────────────────────────────────────────────────

function applyFilter(query) {
    const q = query.toLowerCase();
    _filtered = q
        ? _entries.filter(({ item }) =>
            (item.title || "").toLowerCase().includes(q) ||
            (item.id || "").toLowerCase().includes(q))
        : _entries;

    _anchorPos = null;
    updateCaption(!!q);
    clearTiles();

    if (!_filtered.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = _entries.length
            ? "Ничего не найдено"
            : "В плейлисте нет видео";
        list.appendChild(empty);
        return;
    }

    list.appendChild(sentinel);
    renderNextChunk();
    sentinelObserver.observe(sentinel);
}

function updateCaption(isSearch) {
    const name = _getPlaylistName() || "—";
    const base = isSearch
        ? `${name} · найдено ${_filtered.length} из ${_entries.length}`
        : `${name} · ${_entries.length} видео`;

    const info = _getReorderInfo();
    subtitle.textContent = info.enabled || !info.hint ? base : `${base} · ${info.hint}`;
    subtitle.title = subtitle.textContent;
}

function renderNextChunk() {
    if (_renderedCount >= _filtered.length) return;

    const slice = _filtered.slice(_renderedCount, _renderedCount + CHUNK);
    const frag = document.createDocumentFragment();
    const fresh = [];

    for (let i = 0; i < slice.length; i++) {
        const tile = buildTile(slice[i], _renderedCount + i);
        tile.classList.add("coub-tile--enter");
        fresh.push(tile);
        frag.appendChild(tile);
    }

    list.insertBefore(frag, sentinel);

    // Волна появления: класс снимается с плиток по очереди, дальше их
    // доводит переход в CSS. Через setTimeout, а не requestAnimationFrame —
    // кадры идут не всегда (свёрнутое окно, фоновая вкладка), а плитка
    // обязана стать видимой в любом случае.
    //
    // Задержка растёт только у первых полутора десятков: дальше они всё
    // равно за краем экрана, а ждать своей очереди пришлось бы секунды.
    for (let i = 0; i < fresh.length; i++) {
        const tile = fresh[i];
        setTimeout(() => tile.classList.remove("coub-tile--enter"), Math.min(i, 14) * 30);
    }

    _renderedCount += slice.length;

    if (_renderedCount >= _filtered.length) sentinelObserver.unobserve(sentinel);
}

function buildTile({ item, index }, pos) {
    const tile = document.createElement("div");
    tile.className = "coub-tile";
    tile.dataset.index = index;
    tile.dataset.pos = pos;
    tile.dataset.id = item.key;
    tile.draggable = _reorderEnabled;
    if (index === _getCurrentIndex()) tile.classList.add("coub-tile--active");
    if (_selected.has(item.key)) tile.classList.add("coub-tile--selected");

    const media = document.createElement("div");
    media.className = "coub-tile-media";

    const video = document.createElement("video");
    video.muted = true; // звук идёт отдельной дорожкой через previewAudio
    video.loop = true;
    video.playsInline = true;
    video.draggable = false; // тащим плитку целиком, а не видео внутри неё
    // metadata (а не none) — иначе браузер не дойдёт до кадра #t=0.1 и плитка
    // останется пустой до наведения курсора
    video.preload = "metadata";
    video.dataset.src = item.video || "";
    video.addEventListener("loadeddata", () => video.classList.add("is-ready"));

    // Персональная постобработка ролика видна и в превью. Случайные настройки
    // «Безумия» сюда не тянем — это перемешивание для просмотра списком.
    if (item.fx) {
        const fx = composeSettings(item.fx);
        if (fx.filter) video.style.filter = fx.filter;
        if (fx.transform) video.style.transform = fx.transform;
        // defaultPlaybackRate — чтобы скорость пережила ленивую загрузку src
        video.defaultPlaybackRate = fx.speed;
        video.playbackRate = fx.speed;
    }

    const check = document.createElement("div");
    check.className = "coub-tile-check";
    check.title = "Выделить";

    const indexBadge = document.createElement("span");
    indexBadge.className = "coub-tile-index";
    indexBadge.textContent = index + 1;

    const nowBadge = document.createElement("span");
    nowBadge.className = "coub-tile-now";
    nowBadge.textContent = "Сейчас";

    media.appendChild(video);
    media.appendChild(check);
    media.appendChild(indexBadge);
    media.appendChild(nowBadge);

    const title = document.createElement("div");
    title.className = "coub-tile-title";
    title.textContent = item.title || item.id;
    title.title = item.title || item.id;

    tile.appendChild(media);
    tile.appendChild(title);

    tile.addEventListener("mouseenter", () => startPreview(video, item));
    tile.addEventListener("mouseleave", () => {
        if (_previewVideo === video) stopPreview();
    });

    check.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelection(item.key, Number(tile.dataset.pos), tile);
    });

    tile.addEventListener("click", (e) => {
        e.stopPropagation();

        if (e.shiftKey && _anchorPos !== null) {
            selectRange(_anchorPos, Number(tile.dataset.pos));
            return;
        }
        if (e.ctrlKey || e.metaKey || _selected.size) {
            toggleSelection(item.key, Number(tile.dataset.pos), tile);
            return;
        }
        jumpTo(Number(tile.dataset.index));
    });

    // Пока идёт выделение, обычный клик переключает чекбокс —
    // перейти к ролику можно двойным кликом
    tile.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (!_selected.size) return;
        jumpTo(Number(tile.dataset.index));
    });

    mediaObserver.observe(video);
    return tile;
}

function jumpTo(index) {
    setViewMode("list");
    _onPick?.(index);
}

function scrollActiveIntoView() {
    const current = _getCurrentIndex();
    if (current < 0) return;

    // Текущий ролик может быть ещё не отрисован — дорисовываем порции до него.
    const pos = _filtered.findIndex((e) => e.index === current);
    if (pos === -1) return;
    while (_renderedCount <= pos && _renderedCount < _filtered.length) renderNextChunk();

    list.querySelector(`.coub-tile[data-index="${current}"]`)
        ?.scrollIntoView({ block: "center" });
}

// ─── Перетаскивание (изменение порядка) ───────────────────────────────────

function initDragAndDrop() {
    list.addEventListener("dragstart", (e) => {
        const tile = e.target.closest(".coub-tile");
        if (!tile || !_reorderEnabled) return;

        _dragTile = tile;
        stopPreview();
        e.dataTransfer.effectAllowed = "move";
        // Без setData Firefox не начинает перетаскивание вовсе
        e.dataTransfer.setData("text/plain", tile.dataset.id);
        list.classList.add("coub-grid--dragging");
        requestAnimationFrame(() => tile.classList.add("coub-tile--dragging"));
    });

    list.addEventListener("dragover", (e) => {
        if (!_dragTile) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        autoScroll(e.clientY);

        const target = e.target.closest(".coub-tile");
        if (!target || target === _dragTile) return;

        // Плитки лежат сеткой, поэтому сторону определяем по горизонтали:
        // курсор в левой половине — встать перед плиткой, в правой — после
        const rect = target.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        list.insertBefore(_dragTile, after ? target.nextSibling : target);
    });

    list.addEventListener("drop", (e) => {
        if (_dragTile) e.preventDefault();
    });

    list.addEventListener("dragend", () => {
        if (!_dragTile) return;
        _dragTile.classList.remove("coub-tile--dragging");
        list.classList.remove("coub-grid--dragging");
        _dragTile = null;
        commitReorder();
    });
}

function autoScroll(clientY) {
    const rect = list.getBoundingClientRect();
    if (clientY < rect.top + DRAG_SCROLL_ZONE) list.scrollTop -= 18;
    else if (clientY > rect.bottom - DRAG_SCROLL_ZONE) list.scrollTop += 18;
}

/**
 * Считывает новый порядок из DOM и раскладывает его обратно в модель.
 *
 * Отрисованы всегда первые _renderedCount элементов _filtered, а _filtered
 * может быть подмножеством _entries (включён поиск). Поэтому:
 *   • новый _filtered = порядок плиток в DOM + неотрисованный хвост как был;
 *   • в _entries переставленные ролики раскладываются по тем же позициям,
 *     которые занимали до этого — ровно так же, как это делает сервер
 *     (см. Reorder в PlaylistsController).
 */
function commitReorder() {
    const domTiles = [...list.querySelectorAll(".coub-tile")];
    const renderedEntries = domTiles
        .map((t) => _entryById.get(t.dataset.id))
        .filter(Boolean);

    if (renderedEntries.length !== _renderedCount) return; // рассинхрон — не рискуем

    const newFiltered = [...renderedEntries, ..._filtered.slice(_renderedCount)];
    const unchanged = newFiltered.every((e, i) => e === _filtered[i]);
    if (unchanged) return;

    const filteredKeys = new Set(_filtered.map((e) => e.item.key));
    const slots = [];
    _entries.forEach((e, i) => { if (filteredKeys.has(e.item.key)) slots.push(i); });

    const newEntries = [..._entries];
    slots.forEach((slot, k) => { newEntries[slot] = newFiltered[k]; });

    _entries = newEntries;
    _filtered = newFiltered;
    _entries.forEach((e, i) => { e.index = i; });

    // Плитки уже стоят в нужном порядке — обновляем только подписи и датасеты
    domTiles.forEach((tile, pos) => {
        const entry = _entryById.get(tile.dataset.id);
        if (!entry) return;
        tile.dataset.index = entry.index;
        tile.dataset.pos = pos;
        tile.querySelector(".coub-tile-index").textContent = entry.index + 1;
        tile.classList.toggle("coub-tile--active", entry.index === _getCurrentIndex());
    });
    _anchorPos = null;

    _onReorder?.({
        orderedItems: _entries.map((e) => e.item),
        visibleIds: _filtered.map((e) => e.item.key),
    });
}

// ─── Выделение ────────────────────────────────────────────────────────────

function toggleSelection(id, pos, tile) {
    if (_selected.has(id)) _selected.delete(id);
    else _selected.add(id);

    tile.classList.toggle("coub-tile--selected", _selected.has(id));
    _anchorPos = pos;
    updateBulkBar();
}

function selectRange(fromPos, toPos) {
    const [a, b] = fromPos <= toPos ? [fromPos, toPos] : [toPos, fromPos];
    for (let p = a; p <= b; p++) {
        const entry = _filtered[p];
        if (entry) _selected.add(entry.item.key);
    }
    _anchorPos = toPos;
    syncSelectionClasses();
    updateBulkBar();
}

function clearSelection() {
    _selected.clear();
    _anchorPos = null;
    syncSelectionClasses();
    updateBulkBar();
}

function syncSelectionClasses() {
    list.querySelectorAll(".coub-tile").forEach((tile) => {
        tile.classList.toggle("coub-tile--selected", _selected.has(tile.dataset.id));
    });
}

function updateBulkBar() {
    const n = _selected.size;
    bulkBar.hidden = n === 0;
    list.classList.toggle("coub-grid--selecting", n > 0);
    if (n) bulkCount.textContent = `Выбрано: ${n}`;
    if (!n) closeBulkPopover();
    else if (_bulkMode) updatePopoverTitle();
}

/** Выделенные ролики в порядке текущего списка (а не порядке кликов). */
function selectedItems() {
    return _entries
        .filter(({ item }) => _selected.has(item.key))
        .map(({ item }) => item);
}

// ─── Массовые действия ────────────────────────────────────────────────────

function initBulkActions() {
    bulkAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        for (const entry of _filtered) _selected.add(entry.item.key);
        syncSelectionClasses();
        updateBulkBar();
    });

    bulkClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSelection();
    });

    bulkPlaylistBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBulkPopover(_bulkMode === "playlist" ? null : "playlist");
    });

    bulkTagBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBulkPopover(_bulkMode === "tag" ? null : "tag");
    });

    bulkPresetBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBulkPopover(_bulkMode === "preset" ? null : "preset");
    });

    popoverClose.addEventListener("click", closeBulkPopover);

    popoverInput.addEventListener("input", () => renderPopoverList(popoverInput.value.trim()));
    popoverInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            commitPopoverInput();
        }
    });
    popoverAddBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        commitPopoverInput();
    });
}

function openBulkPopover(mode) {
    if (!mode) {
        closeBulkPopover();
        return;
    }
    _bulkMode = mode;
    const isTag = mode === "tag";

    updatePopoverTitle();
    popoverInput.placeholder = isTag
        ? "Новый или существующий тег…"
        : mode === "preset" ? "Найти пресет…" : "Найти плейлист…";
    popoverInput.maxLength = isTag ? 40 : 80;
    popoverAddBtn.classList.toggle("hidden", !isTag);
    popoverInput.value = "";

    renderPopoverList("");
    popover.classList.remove("hidden");
    requestAnimationFrame(() => popoverInput.focus());
}

function updatePopoverTitle() {
    const label = _bulkMode === "tag" ? "Добавить тег"
        : _bulkMode === "preset" ? "Применить пресет"
            : "В плейлист";
    popoverTitle.textContent = `${label} · ${_selected.size}`;
}

function closeBulkPopover() {
    popover.classList.add("hidden");
    _bulkMode = null;
}

function renderPopoverList(query) {
    const q = query.toLowerCase();
    popoverList.innerHTML = "";

    let rows;
    if (_bulkMode === "tag") {
        rows = _getAllTags()
            .filter(({ tag }) => !q || tag.toLowerCase().includes(q))
            .map(({ tag, count }) => ({ name: tag, note: `${count} видео` }));
    } else if (_bulkMode === "preset") {
        rows = (_getPresets() || [])
            .filter((p) => !q || p.name.toLowerCase().includes(q))
            .map((p) => ({
                name: p.name,
                note: p.bgSeparate
                    ? `${Object.keys(p.fx || {}).length} + фон`
                    : `${Object.keys(p.fx || {}).length} настроек`,
                preset: p,
            }));
    } else {
        rows = Object.entries(_getPlaylists())
            .filter(([name]) => !BULK_EXCLUDED_PLAYLISTS.includes(name))
            .filter(([name]) => !q || name.toLowerCase().includes(q))
            .map(([name, data]) => ({
                name,
                note: `${Object.keys(data.videos || {}).length} видео`,
            }));
    }

    for (const row of rows) popoverList.appendChild(buildPopoverRow(row));

    if (_bulkMode === "playlist") {
        popoverList.appendChild(buildCreatePlaylistRow());
    } else if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = _bulkMode === "preset"
            ? "Пресетов пока нет — сохраните первый во вкладке «Эффекты»"
            : q ? "Нажмите ＋ чтобы создать тег" : "Тегов пока нет";
        popoverList.appendChild(empty);
    }
}

function buildPopoverRow({ name, note, preset }) {
    const row = document.createElement("div");
    row.className = "pl-row";

    const text = document.createElement("div");
    text.className = "pl-row-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-row-name";
    nameEl.textContent = name;

    const noteEl = document.createElement("div");
    noteEl.className = "pl-row-count";
    noteEl.textContent = note;

    text.appendChild(nameEl);
    text.appendChild(noteEl);
    row.appendChild(text);

    row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (_bulkMode === "tag") runBulkTag(name);
        else if (_bulkMode === "preset") runBulkPreset(preset);
        else runBulkPlaylist(name);
    });

    return row;
}

function buildCreatePlaylistRow() {
    const row = document.createElement("div");
    row.className = "pl-row";

    const text = document.createElement("div");
    text.className = "pl-row-text";
    const nameEl = document.createElement("div");
    nameEl.className = "pl-row-name";
    nameEl.textContent = "＋ Создать плейлист";
    text.appendChild(nameEl);
    row.appendChild(text);

    row.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!_onCreatePlaylist) return;
        const name = await _onCreatePlaylist();
        if (name) runBulkPlaylist(name);
    });

    return row;
}

function commitPopoverInput() {
    const value = popoverInput.value.trim();
    if (!value) return;
    if (_bulkMode === "tag") runBulkTag(value);
}

async function runBulkPlaylist(name) {
    if (!_onBulkAddToPlaylist) return;
    await runBulk(
        (items, onProgress) => _onBulkAddToPlaylist(name, items, onProgress),
        (r) => {
            let msg = `<span class="pl-toast-accent">+</span> «${name}»: добавлено ${r.added}`;
            if (r.skipped) msg += `, уже было ${r.skipped}`;
            if (r.failed) msg += `, ошибок ${r.failed}`;
            return msg;
        }
    );
}

async function runBulkTag(tag) {
    if (!_onBulkAddTag) return;
    await runBulk(
        (items, onProgress) => _onBulkAddTag(tag, items, onProgress),
        (r) => {
            let msg = `<span class="pl-toast-accent">#</span> «${tag}»: помечено ${r.added} видео`;
            if (r.failed) msg += `, ошибок ${r.failed}`;
            return msg;
        }
    );
}

async function runBulkPreset(preset) {
    if (!_onBulkApplyPreset || !preset) return;
    await runBulk(
        (items, onProgress) => _onBulkApplyPreset(preset, items, onProgress),
        (r) => {
            let msg = `<span class="pl-toast-accent">✦</span> «${preset.name}»: применён к ${r.applied}`;
            if (r.failed) msg += `, ошибок ${r.failed}`;
            return msg;
        }
    );
}

/**
 * Общая обвязка массовой операции: блокирует панель, показывает прогресс,
 * по завершении сбрасывает выделение и рапортует тостом.
 */
async function runBulk(action, formatToast) {
    if (_bulkBusy) return;
    const items = selectedItems();
    if (!items.length) return;

    _bulkBusy = true;
    setBulkDisabled(true);
    closeBulkPopover();

    try {
        const result = await action(items, (done, total) => {
            bulkCount.textContent = `Обработано ${done}/${total}…`;
        });
        clearSelection();
        showToast(formatToast(result));
    } catch (err) {
        showToast("⚠ Ошибка: " + err.message);
        console.error("Bulk action error:", err);
        updateBulkBar();
    } finally {
        _bulkBusy = false;
        setBulkDisabled(false);
    }
}

function setBulkDisabled(disabled) {
    [bulkAllBtn, bulkClearBtn, bulkPlaylistBtn, bulkTagBtn, bulkPresetBtn].forEach((b) => {
        b.disabled = disabled;
    });
}
