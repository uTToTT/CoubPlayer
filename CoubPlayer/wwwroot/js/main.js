// main.js — точка входа, склейка модулей.

import { loadData } from "./loader.js";
import { buildPlaylist } from "./playlist.js";
import { Player } from "./player.js";
import { initControls } from "./controls.js";
import * as api from "./api.js";
import { state } from "./state.js";
import {
    initPlaylistSelector,
    setPlaylistTriggerLabel,
    updateVideoInfo,
    initVolumeSlider,
    initCopyLinkBtn,
    initSortBar,
    initPlaylistEditor,
    togglePlaylistEditor,
    syncEditorToVideo,
    sanitizeBrokenPlaylists
} from "./ui.js";

// ─── DOM ──────────────────────────────────────────────────────────────────────

const videoIndexInput = document.getElementById("videoIndexInput");
const editPlaylistsBtn = document.getElementById("editPlaylistsBtn");
const downloadCoubsBtn = document.getElementById("downloadCoubsBtn");
const downloadCoubsBtnLabel = downloadCoubsBtn.querySelector(".download-btn-label");

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

function getResolvedPlaylist(name) {
    const obj = state.playlists[name];
    if (!obj?.videos) return [];
    return buildPlaylist(obj, state.coubMap, {
        type: state.sortType,
        direction: state.sortDirection,
        seed: state.randomSeed,
    });
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
    if (!resolved.length) { alert("Playlist empty!"); return; }

    player.setPlaylist(resolved, name);
    // Стартовый индекс резолвится по id последнего просмотренного ролика
    // для ЭТОГО плейлиста (player.currentPlaylistName уже установлен строкой выше)
    const startIndex = player.getStartIndex();
    await player.playPaused(startIndex);
}

async function applySorting() {
    if (!state.selectedPlaylist) return;

    // Запоминаем id текущего ролика ДО пересборки списка — после сортировки
    // порядок меняется, но мы хотим остаться на том же видео, а не прыгать на 0
    const currentId = currentVideo()?.id ?? null;

    await refreshData();
    const resolved = getResolvedPlaylist(state.selectedPlaylist);
    player.setPlaylist(resolved, state.selectedPlaylist);

    const idx = currentId ? resolved.findIndex((v) => v.id === currentId) : -1;
    await player.playPaused(idx === -1 ? 0 : idx);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    await refreshData();

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

    // ── Выбор плейлиста (Pinterest-style) ────────────────────────────────────
    initPlaylistSelector({
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
            // Если удалён активный плейлист — сбросить воспроизведение
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
    });
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

    // Клик по фону = пауза (игнорируем панели и контролы)
    document.body.addEventListener("click", (e) => {
        const ignore = [
            ".button", ".fullscreen-btn", ".bottom-controls",
            "#videoIndexWrapper", ".top-controls",
            ".pl-editor-overlay",
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