// main.js — точка входа, склейка модулей.

import { loadData }     from "./loader.js";
import { buildPlaylist } from "./playlist.js";
import { Player }       from "./player.js";
import { initControls } from "./controls.js";
import * as api         from "./api.js";
import { state }        from "./state.js";
import {
    renderPlaylistDropdown,
    setPlaylistTriggerLabel,
    togglePlaylistMenu,
    hidePlaylistMenu,
    updateVideoInfo,
    initVolumeSlider,
    initCopyLinkBtn,
    initSortBar,
    initPlaylistEditor,
    openPlaylistEditor,
    syncEditorToVideo,
} from "./ui.js";

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const videoIndexInput  = document.getElementById("videoIndexInput");
const editPlaylistsBtn = document.getElementById("editPlaylistsBtn");
const playlistDropdown = document.getElementById("playlistDropdown");

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
    state.coubMap   = data.coubMap;
}

function getResolvedPlaylist(name) {
    const obj = state.playlists[name];
    if (!obj?.videos) return [];
    return buildPlaylist(obj, state.coubMap, {
        type:      state.sortType,
        direction: state.sortDirection,
        seed:      state.randomSeed,
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
    hidePlaylistMenu();

    await refreshData();

    const resolved = getResolvedPlaylist(name);
    if (!resolved.length) { alert("Playlist empty!"); return; }

    player.setPlaylist(resolved, name);
    await player.play(0);
}

async function applySorting() {
    if (!state.selectedPlaylist) return;
    await refreshData();
    const resolved = getResolvedPlaylist(state.selectedPlaylist);
    player.setPlaylist(resolved, state.selectedPlaylist);
    await player.play(0);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    await refreshData();

    // Громкость
    initVolumeSlider((v) => player.setVolume(v));

    // Клавиатура / колесо / кнопки
    initControls(player);

    // Ссылка
    initCopyLinkBtn(() => currentVideo()?.id);

    // Сортировка
    initSortBar((type, direction, seed) => {
        state.sortType      = type;
        state.sortDirection = direction;
        state.randomSeed    = seed;
        applySorting();
    });

    // ── Playlist Editor (Pinterest-style) ─────────────────────────────────────
    initPlaylistEditor({
        getPlaylists: () => state.playlists,

        // Мгновенное переключение — вызывается при каждом клике по строке
        onToggle: async (name, add) => {
            const video = currentVideo();
            if (!video) return;
            if (add) {
                await api.addVideoToPlaylist(name, video.id, video.title);
            } else {
                await api.removeVideoFromPlaylist(name, video.id);
            }
        },

        // Создание нового плейлиста — возвращает имя или null
        onCreatePlaylist: async () => {
            const name = prompt("Название нового плейлиста:");
            if (!name?.trim()) return null;
            await api.createPlaylist({ name: name.trim() });
            state.playlists[name.trim()] = { title: name.trim(), videos: {} };
            return name.trim();
        },
    });

    // Кнопка ✎ открывает панель
    editPlaylistsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const video = currentVideo();
        if (!video) { alert("Нет текущего видео!"); return; }
        openPlaylistEditor(video, state.playlists);
    });

    // ── Playlist Dropdown ─────────────────────────────────────────────────────
    const rebuildDropdown = () =>
        renderPlaylistDropdown(
            state.playlists,
            (name) => selectPlaylist(name),
            async () => {
                const name = prompt("Название нового плейлиста:");
                if (!name?.trim()) return;
                await api.createPlaylist({ name: name.trim() });
                state.playlists[name.trim()] = { title: name.trim(), videos: {} };
                rebuildDropdown();
            }
        );

    playlistDropdown.querySelector(".select-trigger").addEventListener("click", (e) => {
        e.stopPropagation();
        rebuildDropdown();
        togglePlaylistMenu();
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest("#playlistDropdown")) hidePlaylistMenu();
    });

    // Клик по фону = пауза
    document.body.addEventListener("click", (e) => {
        const ignore = [
            ".button", ".fullscreen-btn", ".bottom-controls",
            "#videoIndexWrapper", ".top-controls", ".pl-editor-overlay",
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
        syncEditorToVideo(item);  // обновить панель если открыта
    };

    // Запуск
    rebuildDropdown();
    const defaultName = pickDefaultPlaylist();
    if (defaultName) await selectPlaylist(defaultName);
}

init().catch(console.error);
