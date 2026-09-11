// main.js — точка входа, склейка модулей.

import { loadData } from "./loader.js";
import { buildPlaylist, coubIdFromKey, findKeyForCoub } from "./playlist.js";
import { Player } from "./player.js";
import { initControls } from "./controls.js";
import * as api from "./api.js";
import { state } from "./state.js";
import { initClickEffects } from "./click-effects.js";
import { initGridView, isGridMode, syncGridToVideo, refreshGrid } from "./grid.js";
import {
    RANDOM_TRAITS,
    DEFAULT_MADNESS_TRAITS,
    createRandomizer,
    normalizeTraits,
    rollSeed,
} from "./randomizer.js";
import { revealSimple, revealChars } from "./text-reveal.js";
import {
    initSortingPanel,
    setPlaylistTriggerLabel,
    updateVideoInfo,
    initVolumeSlider,
    initCopyLinkBtn,
    initControlDropdown,
    initSortBar,
    initVideoEditor,          // было: initPlaylistEditor
    toggleVideoEditor,        // было: togglePlaylistEditor
    syncVideoEditorToVideo,   // было: syncEditorToVideo + setVideoTagsTarget
    sanitizeBrokenPlaylists,
    isAnyPanelOpen,
    refreshTagsDatalist,
    initSeekBar,
    initGoToStartButton,
    initImportPlaylist,
    initTransitionModeToggle,
    initMadnessPanel,
    setMadnessAvailable,
    openMadnessPanel,
    setMadnessCurrent,
    syncSortControls,
    setSeedInput,
    showToast,
} from "./ui.js";

const ALL_PLAYLIST_NAME = "Все";

/**
 * Собирает карту id -> title, обходя все реальные плейлисты пользователя.
 * coub_list.json (state.coubMap) тайтлов не хранит — они есть только
 * внутри записей videos[id].title в playlists.json.
 * Если один и тот же ролик встречается в нескольких плейлистах с разными
 * названиями (маловероятно, но возможно), побеждает первое найденное.
 */
function buildTitleMap() {
    const titles = {};
    for (const [name, pl] of Object.entries(state.playlists)) {
        if (name === ALL_PLAYLIST_NAME) continue; // сам ещё не построен на этом шаге
        for (const [key, meta] of Object.entries(pl.videos || {})) {
            // ключ может быть копией ("id#2") — заголовок нужен для самого куба
            const id = coubIdFromKey(key);
            if (!titles[id] && meta.title) titles[id] = meta.title;
        }
    }
    return titles;
}

/**
 * Виртуальный плейлист "Все" — не хранится на сервере, собирается
 * на лету из coubMap. Содержит все скачанные ролики независимо от
 * того, в каком реальном плейлисте они состоят.
 */
function buildAllPlaylist() {
    const titleMap = buildTitleMap();
    const videos = {};
    let order = 0;
    for (const [id, coub] of Object.entries(state.coubMap)) {
        videos[id] = {
            title: titleMap[id] || coub.title || id,
            order: order++,
            lastViewed: null,
        };
    }
    return { videos };
}

// ─── DOM ──────────────────────────────────────────────────────────────────────

const videoIndexInput = document.getElementById("videoIndexInput");
const openFolderBtn = document.getElementById("openFolderBtn");
const downloadCoubsBtn = document.getElementById("downloadCoubsBtn");
const downloadCoubsBtnLabel = downloadCoubsBtn.querySelector(".download-btn-label");
const syncLikedBtn = document.getElementById("syncLikedBtn");
const syncBookmarksBtn = document.getElementById("syncBookmarksBtn");
const realTimeClock = document.getElementById("realTimeClock");
const videoEditBtn = document.getElementById("videoEditBtn"); // было editTagsBtn/editPlaylistsBtn
const duplicateBtn = document.getElementById("duplicateBtn");

function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    realTimeClock.textContent = `${hh}:${mm}:${ss}`;
    // revealChars(realTimeClock,`${hh}:${mm}:${ss}`)
}

// Часы не зависят от загрузки плейлистов/плеера — запускаем сразу
updateClock();
setInterval(updateClock, 1000);

// ─── Player ───────────────────────────────────────────────────────────────────

const player = new Player(
    [document.getElementById("playerA"), document.getElementById("playerB")],
    document.getElementById("audio"),
    document.getElementById("bgVideo")
);

player.setVirtualPlaylistPredicate((name) => name === ALL_PLAYLIST_NAME);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function currentVideo() {
    return player.playlist[player.index] || null;
}

async function refreshData() {
    const data = await loadData();
    state.playlists = data.playlists;
    state.coubMap = data.coubMap;
    state.playlists[ALL_PLAYLIST_NAME] = buildAllPlaylist();
}

// Кэш id роликов, прошедших текущий тег-фильтр. null = фильтр не активен.
let matchingTagIds = null;

async function refreshAllTags() {
    try {
        state.allTags = await api.getAllTags();
    } catch (err) {
        console.error("Не удалось загрузить теги:", err);
        state.allTags = [];
    }
}

async function refreshTagFilterIds() {
    if (!state.activeTagFilter.length) {
        matchingTagIds = null;
        return;
    }
    try {
        const results = await api.searchCoubsByTags(state.activeTagFilter, state.tagFilterMode);
        matchingTagIds = new Set(results.map((r) => (typeof r === "string" ? r : r.id)));
    } catch (err) {
        console.error("Ошибка поиска по тегам:", err);
        matchingTagIds = null;
    }
}

async function applyTagFilterAndRefresh() {
    await refreshTagFilterIds();
    if (state.selectedPlaylist) await applySorting();
}

// ─── Безумие ──────────────────────────────────────────────────────────────────
// Режим сортировки, в котором каждому ролику достаются случайные настройки
// воспроизведения (см. randomizer.js). Какие именно — выбирает пользователь
// галочками; сами значения детерминированы по seed, так что при возврате
// к ролику он выглядит так же.

state.madnessTraits = state.madnessTraits
    ? normalizeTraits(state.madnessTraits)
    : { ...DEFAULT_MADNESS_TRAITS };

let madness = null; // активный рандомизатор, либо null когда режим выключен

// Играл ли плеер до перехода в режим плитки — чтобы вернуть как было
let wasPlayingBeforeGrid = false;

/**
 * Во что «Безумие» превращается на уровне порядка роликов: если галочка
 * «Порядок» стоит — это обычный random с тем же seed, если нет — order.
 */
function effectiveSortType() {
    if (state.sortType !== "madness") return state.sortType;
    return state.madnessTraits.order ? "random" : "order";
}

/** Пересобирает рандомизатор под текущий seed/галочки и отдаёт его плееру. */
function applyMadness() {
    const isMadness = state.sortType === "madness";
    madness = isMadness
        ? createRandomizer({ seed: state.randomSeed, traits: state.madnessTraits })
        : null;

    player.setEffects(madness);
    setMadnessAvailable(isMadness);
    syncSortControls(state.sortType, state.madnessTraits.order);
    updateMadnessCurrent();
}

/** Показывает в панели, что именно выпало текущему ролику. */
function updateMadnessCurrent() {
    setMadnessCurrent(madness ? madness.describe(currentVideo()?.id) : "");
}

function getResolvedPlaylist(name) {
    const obj = state.playlists[name];
    if (!obj?.videos) return [];
    let resolved = buildPlaylist(obj, state.coubMap, {
        type: effectiveSortType(),
        direction: state.sortDirection,
        seed: state.randomSeed,
    });
    if (matchingTagIds) {
        resolved = resolved.filter((item) => matchingTagIds.has(item.id));
    }
    return resolved;
}

function pickDefaultPlaylist() {
    for (const name of ["bookmarks", "liked"]) {
        if (state.playlists[name]) return name;
    }
    return Object.keys(state.playlists)[0] || null;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function selectPlaylist(name) {
    state.selectedPlaylist = name;
    setPlaylistTriggerLabel(name);

    await refreshData();

    const resolved = getResolvedPlaylist(name);
    if (!resolved.length) {
        player.setPlaylist([], name);
        refreshGrid();
        alert(matchingTagIds ? "Нет видео с выбранными тегами в этом плейлисте!" : "Playlist empty!");
        return;
    }

    player.setPlaylist(resolved, name);
    const startIndex = player.getStartIndex();
    await player.playPaused(startIndex);
    refreshGrid();
}

async function applySorting() {
    if (!state.selectedPlaylist) return;

    const currentKey = currentVideo()?.key ?? null;

    await refreshData();
    const resolved = getResolvedPlaylist(state.selectedPlaylist);

    if (!resolved.length) {
        player.setPlaylist([], state.selectedPlaylist);
        refreshGrid();
        alert(matchingTagIds ? "Нет видео с выбранными тегами в этом плейлисте!" : "Playlist empty!");
        return;
    }

    player.setPlaylist(resolved, state.selectedPlaylist);
    const idx = currentKey ? resolved.findIndex((v) => v.key === currentKey) : -1;
    await player.playPaused(idx === -1 ? 0 : idx);
    refreshGrid();
}

/**
 * Докачивает свежие ролики из личной ленты liked/bookmarks с coub.com.
 * Требует access token (remember_token из cookie авторизованной сессии на coub.com) —
 * запрашивается один раз через prompt() и дальше хранится в state (localStorage).
 * @param {"liked"|"bookmarks"} category
 * @param {HTMLButtonElement} btn — кнопка, на которой показывать состояние загрузки
 */
async function syncFavorites(category, btn) {
    if (!state.coubAccessToken) {
        const token = prompt(
            "Нужен access token для доступа к вашим liked/bookmarks на coub.com.\n" +
            "Это значение cookie remember_token (посмотреть можно в DevTools → " +
            "Application → Cookies на coub.com, залогинившись там).\n\n" +
            "Токен сохранится локально в этом браузере."
        );
        if (!token?.trim()) return;
        state.coubAccessToken = token.trim();
    }

    const limitRaw = prompt(
        `Сколько новейших роликов из "${category}" забрать за этот раз?\n` +
        `(введите -1, чтобы забрать все)`,
        "25"
    );
    if (!limitRaw?.trim()) return;

    const limit = parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || (limit <= 0 && limit !== -1)) {
        alert("Некорректное число. Введите положительное число или -1 для «всех».");
        return;
    }

    // Универсально: используем вложенный .download-btn-label, если он есть,
    // иначе работаем с текстом самой кнопки
    const label = btn.querySelector(".download-btn-label") || btn;
    const originalLabel = label.textContent;
    btn.disabled = true;
    label.textContent = "Загрузка…";

    try {
        const results = await api.syncFavorites(category, state.coubAccessToken, limit);
        const ok = results.filter((r) => r.success);
        const failed = results.filter((r) => !r.success);

        let msg = `"${category}": добавлено ${ok.length} из ${results.length}.`;
        if (failed.length) {
            msg += "\n\nНе удалось:\n" + failed.map((f) => `${f.id}: ${f.error}`).join("\n");
        }
        alert(msg);

        await refreshData();
        if (state.selectedPlaylist === category) {
            await selectPlaylist(category);
        }
    } catch (err) {
        alert("Ошибка синхронизации: " + err.message);
        if (/token/i.test(err.message)) {
            state.coubAccessToken = null;
        }
    } finally {
        btn.disabled = false;
        label.textContent = originalLabel;
    }
}

/**
 * Импортирует сторонний плейлист по списку {id, title}.
 * Видео, уже скачанные локально (есть в coub_list.json), просто регистрируются
 * в плейлисте без сети; отсутствующие — докачиваются с coub.com пачкой.
 * Если плейлист с таким именем уже существует — видео добавляются в него (слияние).
 */
async function importPlaylistItems(targetName, items) {
    if (!state.playlists[targetName]) {
        await api.createPlaylist({ name: targetName });
        state.playlists[targetName] = { title: targetName, videos: {} };
    }

    const alreadyInTarget = new Set(
        Object.keys(state.playlists[targetName].videos || {}).map(coubIdFromKey)
    );
    const knownLocally = new Set(Object.keys(state.coubMap));

    const toAddLocally = items.filter((it) => knownLocally.has(it.id) && !alreadyInTarget.has(it.id));
    const toDownload = items.filter((it) => !knownLocally.has(it.id) && !alreadyInTarget.has(it.id));

    for (const it of toAddLocally) {
        try {
            await api.addVideoToPlaylist(targetName, it.id, it.title);
        } catch (err) {
            console.error(`Не удалось добавить ${it.id} в «${targetName}»:`, err);
        }
    }

    let failedDownloads = 0;
    if (toDownload.length) {
        const results = await api.downloadCoubs(targetName, toDownload.map((it) => it.id));
        failedDownloads = results.filter((r) => !r.success).length;
    }

    await refreshData();
    if (state.selectedPlaylist === targetName) {
        await selectPlaylist(targetName);
    }

    return {
        addedLocally: toAddLocally.length,
        downloaded: toDownload.length - failedDownloads,
        failedDownloads,
    };
}

/**
 * Массово добавляет выбранные в сетке ролики в плейлист.
 * Bulk-эндпоинта на сервере нет, поэтому шлём по одному запросу на ролик.
 * Сервер на каждый /add сдвигает order всем уже лежащим в плейлисте видео
 * и кладёт новое в начало, отсюда две особенности:
 *   • идём в обратном порядке — чтобы в плейлисте ролики легли в том же
 *     порядке, в каком шли в сетке;
 *   • уже присутствующие пропускаем — повторный /add перезаписал бы запись
 *     и лишний раз сдвинул order остальным.
 * @param {string} name
 * @param {Array<{id: string, title: string}>} items
 * @param {(done: number, total: number) => void} onProgress
 */
async function bulkAddToPlaylist(name, items, onProgress) {
    const existing = new Set(
        Object.keys(state.playlists[name]?.videos || {}).map(coubIdFromKey)
    );
    // В выделении могли оказаться копии одного ролика — в целевой плейлист
    // он всё равно добавляется один раз
    const seen = new Set();
    const todo = items.filter((it) => {
        if (existing.has(it.id) || seen.has(it.id)) return false;
        seen.add(it.id);
        return true;
    });

    let done = 0;
    let failed = 0;
    for (let i = todo.length - 1; i >= 0; i--) {
        const item = todo[i];
        try {
            await api.addVideoToPlaylist(name, item.id, item.title);
        } catch (err) {
            failed++;
            console.error(`Не удалось добавить ${item.id} в «${name}»:`, err);
        }
        onProgress(++done, todo.length);
    }

    await refreshData();

    return {
        added: todo.length - failed,
        skipped: items.length - todo.length,
        failed,
    };
}

/**
 * Навешивает один тег на все выбранные в сетке ролики.
 * Сервер сам игнорирует повторное добавление того же тега, так что
 * фильтровать уже помеченные на клиенте не нужно.
 * @param {string} tag
 * @param {Array<{id: string}>} items
 * @param {(done: number, total: number) => void} onProgress
 */
async function bulkAddTag(tag, items, onProgress) {
    let done = 0;
    let failed = 0;
    for (const item of items) {
        try {
            await api.addTagToCoub(item.id, tag);
        } catch (err) {
            failed++;
            console.error(`Не удалось добавить тег «${tag}» к ${item.id}:`, err);
        }
        onProgress(++done, items.length);
    }

    await refreshAllTags();
    refreshTagsDatalist(state.allTags);
    if (state.activeTagFilter.length) await applyTagFilterAndRefresh();

    return { added: items.length - failed, failed };
}

/**
 * Можно ли сейчас менять порядок роликов перетаскиванием в сетке.
 * Порядок хранится в самом плейлисте (VideoMeta.order), поэтому таскать
 * имеет смысл, только когда сетка показывает плейлист именно в этом порядке.
 * @returns {{enabled: boolean, hint: string}}
 */
function getReorderInfo() {
    if (!state.selectedPlaylist) {
        return { enabled: false, hint: "" };
    }
    if (state.selectedPlaylist === ALL_PLAYLIST_NAME) {
        return {
            enabled: false,
            hint: "«Все» собирается на лету, порядок не сохраняется",
        };
    }
    if (effectiveSortType() !== "order") {
        return {
            enabled: false,
            hint: "перетаскивание доступно при сортировке Order",
        };
    }
    return { enabled: true, hint: "" };
}

/**
 * Применяет новый порядок, полученный перетаскиванием в сетке.
 * Плейлист плеера переставляем на месте (без перезапуска ролика), после чего
 * сохраняем порядок на сервере. visibleIds — только то, что реально видно
 * в сетке; при сортировке по убыванию отдаём их развёрнутыми, потому что
 * сервер раздаёт позиции по возрастанию order.
 * @param {{orderedItems: Array<object>, visibleIds: string[]}} change
 */
async function applyReorder({ orderedItems, visibleIds }) {
    const playlistName = state.selectedPlaylist;
    const currentId = currentVideo()?.id ?? null;

    player.setPlaylist(orderedItems, playlistName);
    const idx = currentId ? orderedItems.findIndex((v) => v.id === currentId) : -1;
    if (idx !== -1) player.index = idx;
    updateVideoInfo(player.index, orderedItems[player.index]?.title, orderedItems.length);

    const ids = state.sortDirection === "desc" ? [...visibleIds].reverse() : visibleIds;

    try {
        await api.reorderPlaylist(playlistName, ids);
        await refreshData();
    } catch (err) {
        console.error("Не удалось сохранить порядок:", err);
        alert("Не удалось сохранить порядок: " + err.message);
        // Возвращаемся к тому, что реально лежит на сервере
        await applySorting();
    }
}

// ─── Дубликаты и персональная постобработка ──────────────────────────────────

/** Можно ли сейчас править записи плейлиста (дублировать, задавать эффекты). */
function playlistIsEditable() {
    if (!state.selectedPlaylist) {
        return { editable: false, note: "Сначала выберите плейлист." };
    }
    if (state.selectedPlaylist === ALL_PLAYLIST_NAME) {
        return {
            editable: false,
            note: `«${ALL_PLAYLIST_NAME}» собирается на лету и не хранится — ` +
                "дубликаты и эффекты сохранять некуда. Откройте обычный плейлист.",
        };
    }
    return {
        editable: true,
        note: "Настройки сохраняются в этой записи плейлиста, поэтому у копий " +
            "одного ролика они могут отличаться.",
    };
}

/**
 * Добавляет копию текущего ролика сразу после него.
 * Файлы не копируются — в плейлисте появляется вторая запись того же куба
 * (ключ "id#2"), со своим порядком и своей постобработкой.
 * Воспроизведение не прерываем: список пересобираем на месте.
 */
async function duplicateCurrentVideo() {
    const video = currentVideo();
    if (!video) {
        alert("Нет текущего видео!");
        return;
    }

    const { editable, note } = playlistIsEditable();
    if (!editable) {
        alert(note);
        return;
    }

    try {
        await api.duplicateVideo(state.selectedPlaylist, video.key);
    } catch (err) {
        alert("Не удалось дублировать: " + err.message);
        return;
    }

    await refreshData();
    const resolved = getResolvedPlaylist(state.selectedPlaylist);
    player.setPlaylist(resolved, state.selectedPlaylist);

    const idx = resolved.findIndex((v) => v.key === video.key);
    if (idx !== -1) player.index = idx;
    updateVideoInfo(player.index, resolved[player.index]?.title, resolved.length);

    refreshGrid();
    showToast(`<span class="pl-toast-accent">⧉</span> Копия добавлена после текущего`);
}

/** Раскладывает набор настроек по записи плейлиста (локально, без сети). */
function assignFxToItem(item, { fx, bgFx, bgSeparate }) {
    if (!item) return;
    item.fx = fx && Object.keys(fx).length ? fx : null;
    item.bgSeparate = !!bgSeparate;
    item.bgFx = bgSeparate && bgFx && Object.keys(bgFx).length ? bgFx : null;
}

/**
 * Применяет персональную постобработку к записи плейлиста.
 * persist=false — только показать результат (пока пользователь тянет ползунок),
 * persist=true — ещё и сохранить на сервере.
 */
async function applyVideoFx(key, settings, { persist }) {
    if (!key) return;

    const item = player.playlist.find((v) => v.key === key);
    if (item) {
        assignFxToItem(item, settings);
        if (player.playlist[player.index]?.key === key) player.refreshEffects();
    }

    if (!persist) return;

    const { editable } = playlistIsEditable();
    if (!editable) return;

    try {
        await api.setVideoFx(state.selectedPlaylist, key, settings);
        assignFxToItem(state.playlists[state.selectedPlaylist]?.videos?.[key], settings);
    } catch (err) {
        console.error("Не удалось сохранить постобработку:", err);
        showToast("⚠ Не удалось сохранить эффекты");
    }
}

// ─── Пресеты постобработки ───────────────────────────────────────────────────

async function refreshFxPresets() {
    try {
        state.fxPresets = await api.getFxPresets();
    } catch (err) {
        console.error("Не удалось загрузить пресеты:", err);
        state.fxPresets = [];
    }
}

async function saveFxPreset(preset) {
    try {
        state.fxPresets = await api.saveFxPreset(preset);
        showToast(`<span class="pl-toast-accent">✦</span> Пресет «${preset.name}» сохранён`);
    } catch (err) {
        console.error("Не удалось сохранить пресет:", err);
        showToast("⚠ Не удалось сохранить пресет");
    }
}

async function deleteFxPreset(name) {
    try {
        state.fxPresets = await api.deleteFxPreset(name);
    } catch (err) {
        console.error("Не удалось удалить пресет:", err);
        showToast("⚠ Не удалось удалить пресет");
    }
}

/**
 * Применяет пресет сразу к нескольким записям плейлиста.
 * @param {{name: string, fx?: object, bgFx?: object, bgSeparate?: boolean}} preset
 * @param {Array<{key: string}>} items
 * @param {(done: number, total: number) => void} onProgress
 */
async function bulkApplyPreset(preset, items, onProgress) {
    const { editable, note } = playlistIsEditable();
    if (!editable) throw new Error(note);

    const settings = {
        fx: { ...(preset.fx || {}) },
        bgFx: { ...(preset.bgFx || {}) },
        bgSeparate: !!preset.bgSeparate,
    };

    let done = 0;
    let failed = 0;
    for (const item of items) {
        try {
            await api.setVideoFx(state.selectedPlaylist, item.key, settings);
            assignFxToItem(player.playlist.find((v) => v.key === item.key), settings);
            assignFxToItem(state.playlists[state.selectedPlaylist]?.videos?.[item.key], settings);
        } catch (err) {
            failed++;
            console.error(`Не удалось применить пресет к ${item.key}:`, err);
        }
        onProgress(++done, items.length);
    }

    player.refreshEffects();
    refreshGrid();

    return { applied: items.length - failed, failed };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    await refreshData();
    await refreshAllTags();
    await refreshFxPresets();
    await refreshTagFilterIds(); // фильтр мог сохраниться с прошлой сессии

    initClickEffects({
        color: "#f43f5e",   // можно поменять на var(--accent-2) / #ec4899 для розового
        duration: 300,
        strokeWidth: 2,
        effectSize: 90,
    });

    // Громкость
    const setVolumeSlider = initVolumeSlider(
        (value) => {
            player.setVolume(value);
            state.volume = value;
        },
        state.volume
    );

    // Клавиатура / колесо / кнопки
    initControls(player, setVolumeSlider);

    // Ссылка и папка — одной кнопкой со списком
    initCopyLinkBtn(() => currentVideo()?.id);
    initControlDropdown();

    const seekBar = initSeekBar((ratio) => {
        const duration = player.getDuration();
        if (!duration) return;
        player.seek(ratio * duration);
    });

    function seekLoop() {
        seekBar.update(player.getCurrentTime(), player.getDuration());
        requestAnimationFrame(seekLoop);
    }
    requestAnimationFrame(seekLoop);

    // Сортировка
    initSortBar((type, direction, seed) => {
        const enteredMadness = type === "madness" && state.sortType !== "madness";

        state.sortType = type;
        state.sortDirection = direction;
        state.randomSeed = seed;

        applyMadness();
        applySorting();

        // Режим бессмысленно включать вслепую — сразу показываем, что он делает
        if (enteredMadness) openMadnessPanel();
    }, {
        sortType: state.sortType,
        sortDirection: state.sortDirection,
        randomSeed: state.randomSeed,
        madnessShufflesOrder: () => state.madnessTraits.order,
    });

    // Панель «Безумие» — набор рандомизируемых настроек
    initMadnessPanel({
        traits: RANDOM_TRAITS,
        getEnabled: () => state.madnessTraits,
        onChange: (enabled) => {
            const prevOrder = !!state.madnessTraits.order;
            state.madnessTraits = normalizeTraits(enabled);
            applyMadness();
            // Пересобирать плейлист нужно только если поменялся сам порядок —
            // визуальные настройки применяются на лету, не трогая воспроизведение
            if (prevOrder !== !!state.madnessTraits.order) applySorting();
        },
        onReshuffle: () => {
            state.randomSeed = rollSeed();
            setSeedInput(state.randomSeed);
            applyMadness();
            if (state.madnessTraits.order) applySorting();
        },
    });

    applyMadness();

    // Режим перехода между видео (сохранённый выбор + переключатель)
    player.setTransitionMode(state.transitionMode);
    initTransitionModeToggle((mode) => {
        state.transitionMode = mode;
        player.setTransitionMode(mode);
    }, state.transitionMode);

    initGoToStartButton(() => player.goToIndex(1));

    // Просмотр текущего плейлиста плиткой
    initGridView({
        getItems: () => player.playlist,
        getCurrentIndex: () => player.index,
        getPlaylistName: () => state.selectedPlaylist,
        onPick: (index) => {
            if (index !== player.index) player.goToIndex(index + 1);
        },
        getTileSize: () => state.gridTileSize,
        onTileSizeChange: (size) => { state.gridTileSize = size; },
        getViewMode: () => state.viewMode,
        onViewModeChange: (mode) => { state.viewMode = mode; },

        // Превью в сетке звучит само, поэтому на это время глушим основной плеер.
        // state.volume не трогаем — это пользовательская настройка, ползунок
        // должен остаться на своём месте.
        getVolume: () => state.volume,
        onPreviewActive: (active) => player.setVolume(active ? 0 : state.volume),

        getPlaylists: () => state.playlists,
        onCreatePlaylist: async () => {
            const name = prompt("Название нового плейлиста:");
            if (!name?.trim()) return null;
            await api.createPlaylist({ name: name.trim() });
            state.playlists[name.trim()] = { title: name.trim(), videos: {} };
            return name.trim();
        },
        onBulkAddToPlaylist: (name, items, onProgress) =>
            bulkAddToPlaylist(name, items, onProgress),
        getAllTags: () => state.allTags,
        onBulkAddTag: (tag, items, onProgress) => bulkAddTag(tag, items, onProgress),
        getPresets: () => state.fxPresets,
        onBulkApplyPreset: (preset, items, onProgress) =>
            bulkApplyPreset(preset, items, onProgress),

        getReorderInfo: () => getReorderInfo(),
        onReorder: (change) => applyReorder(change),

        // В режиме плитки плеер выключается целиком; возвращаясь к списку,
        // восстанавливаем то состояние, в котором он был до переключения
        onPlayerActive: (active) => {
            if (!active) {
                wasPlayingBeforeGrid = !player.isPaused;
                player.pause();
            } else if (wasPlayingBeforeGrid) {
                player.resume();
            }
        },
        onBgPreview: (videoEl, item) => player.setBgPreview(videoEl, item),
    });

    initVideoEditor({
        getPlaylists: () => state.playlists,
        onToggle: async (name, add) => {
            const video = currentVideo();
            if (!video) return;
            if (add) {
                await api.addVideoToPlaylist(name, video.id, video.title);
            } else {
                // Отдаём id куба: если ролик лежит в плейлисте копией, нужную
                // запись найдёт сервер — у него данные заведомо актуальные
                await api.removeVideoFromPlaylist(name, video.id);
            }
        },
        onCreatePlaylist: async () => {
            const name = prompt("Название нового плейлиста:");
            if (!name?.trim()) return null;
            await api.createPlaylist({ name: name.trim() });
            state.playlists[name.trim()] = { title: name.trim(), videos: {} };
            return name.trim();
        },
        getCoubTags: (id) => api.getCoubTags(id),
        addTag: (id, tag) => api.addTagToCoub(id, tag),
        removeTag: (id, tag) => api.removeTagFromCoub(id, tag),
        getAllTags: () => state.allTags,
        onTagsChanged: async () => {
            await refreshAllTags();
            refreshTagsDatalist(state.allTags);
            if (state.activeTagFilter.length) await applyTagFilterAndRefresh();
        },
        getFxContext: () => playlistIsEditable(),
        onFxChange: (key, settings, opts) => applyVideoFx(key, settings, opts),
        onDuplicate: () => duplicateCurrentVideo(),
        getPresets: () => state.fxPresets,
        onSavePreset: (preset) => saveFxPreset(preset),
        onDeletePreset: (name) => deleteFxPreset(name),
    });

    duplicateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        duplicateCurrentVideo();
        duplicateBtn.blur();
    });


    videoEditBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const video = currentVideo();
        if (!video) { alert("Нет текущего видео!"); return; }
        toggleVideoEditor(video, state.playlists);
        videoEditBtn.blur();
    });


    openFolderBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const video = currentVideo();
        if (!video) {
            alert("Нет текущего видео!");
            return;
        }
        try {
            await api.openCoubFolder(video.id);
        } catch (err) {
            alert("Не удалось открыть папку: " + err.message);
        }
        openFolderBtn.blur();
    });


    // ── Единая панель: Плейлисты + Теги ──────────────────────────────────────
    initSortingPanel({
        // playlists
        getPlaylists: () => state.playlists,
        onSelect: (name) => selectPlaylist(name),
        onCreate: async () => {
            const name = prompt("Название нового плейлиста:");
            if (!name?.trim()) return null;
            await api.createPlaylist({ name: name.trim() });
            state.playlists[name.trim()] = { title: name.trim(), videos: {} };
            return name.trim();
        },
        onDelete: async (name) => {
            if (name === ALL_PLAYLIST_NAME) return;
            await api.deletePlaylist(name);
            delete state.playlists[name];
            if (state.selectedPlaylist === name) {
                state.selectedPlaylist = null;
                player.setPlaylist([], null);
            }
        },
        onRename: async (oldName, newName) => {
            if (oldName === ALL_PLAYLIST_NAME) return;
            await api.renamePlaylist(oldName, newName);
            state.playlists[newName] = state.playlists[oldName];
            delete state.playlists[oldName];
            if (state.selectedPlaylist === oldName) {
                state.selectedPlaylist = newName;
                setPlaylistTriggerLabel(newName);
            }
        },
        // tags
        getAllTags: () => state.allTags,
        getActiveTagFilter: () => state.activeTagFilter,
        getTagFilterMode: () => state.tagFilterMode,
        onTagFilterChange: (tags, mode) => {
            state.activeTagFilter = tags;
            state.tagFilterMode = mode;
            applyTagFilterAndRefresh();
        },
        onRenameTag: async (oldTag, newTag) => {
            await api.renameTag(oldTag, newTag);
            await refreshAllTags();
            refreshTagsDatalist(state.allTags);
            if (state.activeTagFilter.includes(oldTag)) {
                state.activeTagFilter = state.activeTagFilter.map((t) =>
                    t === oldTag ? newTag : t
                );
                await applyTagFilterAndRefresh();
            }
        },
        onDeleteTag: async (tag) => {
            await api.deleteTag(tag);
            await refreshAllTags();
            refreshTagsDatalist(state.allTags);
            if (state.activeTagFilter.includes(tag)) {
                state.activeTagFilter = state.activeTagFilter.filter((t) => t !== tag);
                await applyTagFilterAndRefresh();
            }
        },
        // баннеры
        getCoubMap: () => state.coubMap,
        onBannerChanged: () => refreshData(),
        onDeleteAllTags: async () => {
            await api.deleteAllTags();
            state.allTags = [];
            refreshTagsDatalist([]);
            state.activeTagFilter = [];
            await applyTagFilterAndRefresh();
        },
    });

    await sanitizeBrokenPlaylists();

    // Загрузка видео по ссылке (одной или нескольким)
    downloadCoubsBtn.addEventListener("click", async (e) => {
        e.stopPropagation();

        if (!state.selectedPlaylist) {
            alert("Сначала выберите плейлист, куда добавлять видео.");
            return;
        }

        const raw = prompt(
            "Вставьте ссылку на coub (https://coub.com/view/...) " +
            "или несколько ссылок через пробел/запятую/перенос строки:"
        );
        if (!raw?.trim()) return;

        const urls = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        if (!urls.length) return;

        const originalLabel = downloadCoubsBtnLabel.textContent;
        downloadCoubsBtn.disabled = true;
        downloadCoubsBtnLabel.textContent = urls.length > 1 ? `0/${urls.length}…` : "Загрузка…";

        try {
            const results = await api.downloadCoubs(state.selectedPlaylist, urls);
            const ok = results.filter((r) => r.success);
            const failed = results.filter((r) => !r.success);

            let msg = `Добавлено: ${ok.length} из ${urls.length}.`;
            if (failed.length) {
                msg += "\n\nНе удалось:\n" + failed.map((f) => `${f.id}: ${f.error}`).join("\n");
            }
            alert(msg);

            if (ok.length > 0) {
                // Плейлист изменился на сервере — перезагружаем его в плеере.
                // Стартовый индекс всё так же резолвится по id последнего просмотренного видео.
                await selectPlaylist(state.selectedPlaylist);
            }
        } catch (err) {
            alert("Ошибка загрузки: " + err.message);
        } finally {
            downloadCoubsBtn.disabled = false;
            downloadCoubsBtnLabel.textContent = originalLabel;
        }
    });

    syncLikedBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        syncFavorites("liked", syncLikedBtn);
    });

    syncBookmarksBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        syncFavorites("bookmarks", syncBookmarksBtn);
    });

    // Клик по фону = пауза (игнорируем панели и контролы)
    document.body.addEventListener("click", (e) => {
        // Если открыта панель (редактор/селектор плейлистов) — не трогаем паузу.
        // Закрытие панели по клику мимо неё обрабатывает document-listener в ui.js.
        if (isAnyPanelOpen() || isGridMode()) return;

        const ignore = [
            ".button", ".fullscreen-btn", ".bottom-controls",
            "#videoIndexWrapper", ".top-controls", "#seekBarWrapper",
        ];
        if (!ignore.some((sel) => e.target.closest(sel))) player.togglePause();
    });

    // Переход по номеру
    videoIndexInput.addEventListener("input", () => {
        player.goToIndex(videoIndexInput.value);
    });

    // Колбэк смены видео.
    // Персист последнего ролика (по id, для конкретного плейлиста) делает сам
    // Player._notifyChange — тут его дублировать не нужно.
    player.onVideoChange = (item) => {
        updateVideoInfo(player.index, item.title, player.playlist.length);
        syncVideoEditorToVideo(item);
        syncGridToVideo();
        updateMadnessCurrent();
    };

    player.activeVideo.addEventListener("play", () => updatePauseOverlay(false));
    player.activeVideo.addEventListener("pause", () => updatePauseOverlay(true));

    // Запуск дефолтного плейлиста.
    // Стартовый индекс для него резолвится уже внутри selectPlaylist() по id.
    const defaultName = (state.selectedPlaylist && state.playlists[state.selectedPlaylist])
        ? state.selectedPlaylist
        : pickDefaultPlaylist();
    if (defaultName) {
        await selectPlaylist(defaultName);
    }

    player.onPlayStateChange = (isPaused) => updatePauseOverlay(isPaused);

    function updatePauseOverlay(isPaused) {
        document.getElementById("pauseOverlay").classList.toggle("visible", isPaused);
    }

    initImportPlaylist({
        getPlaylists: () => state.playlists,
        onImport: (targetName, items) => importPlaylistItems(targetName, items),
    });
}

init().catch(console.error);