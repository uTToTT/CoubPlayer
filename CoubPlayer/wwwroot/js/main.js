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

async function selectPlaylist(name, startIndex = 0) {
    state.selectedPlaylist = name;
    setPlaylistTriggerLabel(name);

    await refreshData();

    const resolved = getResolvedPlaylist(name);
    if (!resolved.length) { alert("Playlist empty!"); return; }

    player.setPlaylist(resolved, name);
    await player.playPaused(startIndex);
}

async function applySorting() {
    if (!state.selectedPlaylist) return;
    await refreshData();
    const resolved = getResolvedPlaylist(state.selectedPlaylist);
    player.setPlaylist(resolved, state.selectedPlaylist);
    await player.playPaused(0);
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

    // Колбэк смены видео
    player.onVideoChange = (item) => {
        updateVideoInfo(player.index, item.title, player.playlist.length);
        syncEditorToVideo(item);
        state.videoIndex = player.index; // ← сохраняем
    };

    player.activeVideo.addEventListener("play", () => updatePauseOverlay(false));
    player.activeVideo.addEventListener("pause", () => updatePauseOverlay(true));

    // Запуск дефолтного плейлиста
    const defaultName = (state.selectedPlaylist && state.playlists[state.selectedPlaylist])
        ? state.selectedPlaylist
        : pickDefaultPlaylist();
    if (defaultName) {
        const startIndex = (defaultName === state.selectedPlaylist)
            ? (state.videoIndex ?? 0)
            : 0;
        await selectPlaylist(defaultName, startIndex);
    }

    player.onPlayStateChange = (isPaused) => updatePauseOverlay(isPaused);

    function updatePauseOverlay(isPaused) {
        document.getElementById("pauseOverlay").classList.toggle("visible", isPaused);
    }
}

init().catch(console.error);
