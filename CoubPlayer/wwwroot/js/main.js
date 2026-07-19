// main.js — точка входа, склейка модулей.

import { loadData } from "./loader.js";
import { buildPlaylist } from "./playlist.js";
import { Player } from "./player.js";
import { initControls } from "./controls.js";
import * as api from "./api.js";
import { state } from "./state.js";
import {
    initSortingPanel,          // было initPlaylistSelector + initTagFilterPanel
    setPlaylistTriggerLabel,
    updateVideoInfo,
    initVolumeSlider,
    initCopyLinkBtn,
    initSortBar,
    initPlaylistEditor,
    togglePlaylistEditor,
    syncEditorToVideo,
    sanitizeBrokenPlaylists,
    isAnyPanelOpen,
    initVideoTagsEditor,
    setVideoTagsTarget,
    refreshTagsDatalist,
    initSeekBar,
} from "./ui.js";

// ─── DOM ──────────────────────────────────────────────────────────────────────

const videoIndexInput = document.getElementById("videoIndexInput");
const editPlaylistsBtn = document.getElementById("editPlaylistsBtn");
const downloadCoubsBtn = document.getElementById("downloadCoubsBtn");
const downloadCoubsBtnLabel = downloadCoubsBtn.querySelector(".download-btn-label");
const syncLikedBtn = document.getElementById("syncLikedBtn");
const syncBookmarksBtn = document.getElementById("syncBookmarksBtn");
const realTimeClock = document.getElementById("realTimeClock");

function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    realTimeClock.textContent = `${hh}:${mm}:${ss}`;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function currentVideo() {
    return player.playlist[player.index] || null;
}

async function refreshData() {
    const data = await loadData();
    state.playlists = data.playlists;
    state.coubMap = data.coubMap;
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

function getResolvedPlaylist(name) {
    const obj = state.playlists[name];
    if (!obj?.videos) return [];
    let resolved = buildPlaylist(obj, state.coubMap, {
        type: state.sortType,
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
        alert(matchingTagIds ? "Нет видео с выбранными тегами в этом плейлисте!" : "Playlist empty!");
        return;
    }

    player.setPlaylist(resolved, name);
    const startIndex = player.getStartIndex();
    await player.playPaused(startIndex);
}

async function applySorting() {
    if (!state.selectedPlaylist) return;

    const currentId = currentVideo()?.id ?? null;

    await refreshData();
    const resolved = getResolvedPlaylist(state.selectedPlaylist);

    if (!resolved.length) {
        player.setPlaylist([], state.selectedPlaylist);
        alert(matchingTagIds ? "Нет видео с выбранными тегами в этом плейлисте!" : "Playlist empty!");
        return;
    }

    player.setPlaylist(resolved, state.selectedPlaylist);
    const idx = currentId ? resolved.findIndex((v) => v.id === currentId) : -1;
    await player.playPaused(idx === -1 ? 0 : idx);
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
        `Сколько новейших роликов из "${category}" забрать за этот раз?`,
        "25"
    );
    if (!limitRaw?.trim()) return;

    const limit = parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
        alert("Некорректное число.");
        return;
    }

    const label = btn.querySelector(".download-btn-label");
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

        // Плейлист category мог быть только что создан сервером впервые —
        // подтягиваем актуальный список плейлистов и, если он сейчас открыт, перезагружаем
        await refreshData();
        if (state.selectedPlaylist === category) {
            await selectPlaylist(category);
        }
    } catch (err) {
        alert("Ошибка синхронизации: " + err.message);
        // Если сервер пожаловался на токен — сбрасываем сохранённый, чтобы он не долбил
        // сервер повторно тем же неверным значением при следующей попытке
        if (/token/i.test(err.message)) {
            state.coubAccessToken = null;
        }
    } finally {
        btn.disabled = false;
        label.textContent = originalLabel;
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    await refreshData();
    await refreshAllTags();
    await refreshTagFilterIds(); // фильтр мог сохраниться с прошлой сессии

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

    // Ссылка
    initCopyLinkBtn(() => currentVideo()?.id);

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
        state.sortType = type;
        state.sortDirection = direction;
        state.randomSeed = seed;
        applySorting();
    }, {
        sortType: state.sortType,
        sortDirection: state.sortDirection,
        randomSeed: state.randomSeed,
    });

    // ── Теги текущего видео ────────────────────────────────────────────────
    initVideoTagsEditor({
        getCoubTags: (id) => api.getCoubTags(id),
        addTag: (id, tag) => api.addTagToCoub(id, tag),
        removeTag: (id, tag) => api.removeTagFromCoub(id, tag),
        getAllTags: () => state.allTags,
        onTagsChanged: async () => {
            await refreshAllTags();
            refreshTagsDatalist(state.allTags);
            if (state.activeTagFilter.length) await applyTagFilterAndRefresh();
        },
    });

    // ── Выбор плейлиста (Pinterest-style) ────────────────────────────────────

    // ── Редактор плейлистов для видео (Pinterest-style) ───────────────────────
    initPlaylistEditor({
        getPlaylists: () => state.playlists,
        onToggle: async (name, add) => {
            const video = currentVideo();
            if (!video) return;
            if (add) {
                await api.addVideoToPlaylist(name, video.id, video.title);
            } else {
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
    });


    // Кнопка ✎ открывает редактор
    editPlaylistsBtn.addEventListener("click", (e) => {
        console.log("editPlaylistsBtn clicked, currentVideo =", currentVideo()?.id);
        e.stopPropagation();
        const video = currentVideo();
        if (!video) { alert("Нет текущего видео!"); return; }
        togglePlaylistEditor(video, state.playlists);
        editPlaylistsBtn.blur();
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
            await api.deletePlaylist(name);
            delete state.playlists[name];
            if (state.selectedPlaylist === name) {
                state.selectedPlaylist = null;
                player.setPlaylist([], null);
            }
        },
        onRename: async (oldName, newName) => {
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
        if (isAnyPanelOpen()) return;

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
        syncEditorToVideo(item);
        setVideoTagsTarget(item); // NEW
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


}

init().catch(console.error);