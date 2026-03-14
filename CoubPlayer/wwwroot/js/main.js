//main.js
import { loadData } from "./loader.js";
import { buildPlaylist } from "./playlist.js";
import { Player } from "./player.js";
import { initControls } from "./controls.js";
import * as api from "./api.js";

const players = [
    document.getElementById("playerA"),
    document.getElementById("playerB")
];

const audio = document.getElementById("audio");
const bgVideo = document.getElementById("bgVideo");

const playlistSelect = document.getElementById("playlistSelect");
const newPlaylistInput = document.getElementById("newPlaylistName");
const createPlaylistBtn = document.getElementById("createPlaylistBtn");
const playlistCheckboxes = document.getElementById("playlistCheckboxes");

const editPlaylistsBtn = document.getElementById("editPlaylistsBtn");
const playlistContainer = document.getElementById("playlistCheckboxesContainer");
const savePlaylistsBtn = document.getElementById("savePlaylistsBtn");
const cancelPlaylistsBtn = document.getElementById("cancelPlaylistsBtn");

const player = new Player(players, audio, bgVideo);

let started = false;

let playlistsData = {};
let coubMapData = {};

function updatePlayerPlaylist() {
    const selected = playlistSelect.value;
    if (!selected) return;

    const playlist = buildPlaylist(playlistsData, coubMapData, selected);
    player.setPlaylist(playlist);

    // Если предыдущий индекс больше длины — начинаем с 0
    if (player.index >= playlist.length) player.play(0);
}

async function openPlaylistEditor() {
    const currentVideo = player.playlist[player.index];
    if (!currentVideo) return alert("Нет текущего видео!");

    // свежие плейлисты
    const { playlists } = await loadData();
    playlistsData = playlists;

    // очищаем контейнер
    playlistCheckboxes.innerHTML = "";

    for (const name of Object.keys(playlistsData)) {
        const label = document.createElement("label");
        label.style.display = "block";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = name;

        // если видео уже в плейлисте — галочка
        if (playlistsData[name].videos[currentVideo.id]) {
            checkbox.checked = true;
        }

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + name));
        playlistCheckboxes.appendChild(label);
    }

    playlistContainer.style.display = "block";
}

async function refreshPlaylists() {
    const { playlists, coubMap } = await loadData();
    playlistsData = playlists;
    coubMapData = coubMap;

    // --- Обновляем чекбоксы ---
    playlistCheckboxes.innerHTML = "";
    for (const name of Object.keys(playlistsData)) {
        const label = document.createElement("label");
        label.style.display = "block";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = name;

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + name));
        playlistCheckboxes.appendChild(label);
    }

    // --- Обновляем select для одиночного выбора плейлиста ---
    playlistSelect.innerHTML = '<option value="">Choose playlist</option>';
    for (const name of Object.keys(playlistsData)) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        playlistSelect.appendChild(option);
    }
}

async function init() {
    await refreshPlaylists();
    initControls(player, bgVideo, audio);

    playlistSelect.addEventListener("change", async () => {
        const selected = playlistSelect.value;
        if (!selected) return;

        const { playlists, coubMap } = await loadData();
        playlistsData = playlists;
        coubMapData = coubMap;

        const playlist = buildPlaylist(playlistsData, coubMapData, selected);
        if (!playlist || !playlist.length) {
            alert("Playlist is empty or not found!");
            return;
        }

        player.setPlaylist(playlist);
        player.play(0);

        started = true;
    });


    createPlaylistBtn.addEventListener("click", async () => {
        const name = newPlaylistInput.value.trim();
        if (!name) return;

        await api.createPlaylist({ name });

        newPlaylistInput.value = "";

        await refreshPlaylists();
    });

    editPlaylistsBtn.addEventListener("click", openPlaylistEditor);

    cancelPlaylistsBtn.addEventListener("click", () => {
        playlistContainer.style.display = "none";
    });

    // сохранить изменения
    savePlaylistsBtn.addEventListener("click", async () => {
        const currentVideo = player.playlist[player.index];
        if (!currentVideo) return alert("Нет текущего видео!");

        const checkboxes = playlistCheckboxes.querySelectorAll("input[type=checkbox]");
        for (const ch of checkboxes) {
            const inPlaylist = playlistsData[ch.value].videos[currentVideo.id];
            if (ch.checked && !inPlaylist) {
                await api.addVideoToPlaylist(ch.value, currentVideo.id, currentVideo.title);
            } else if (!ch.checked && inPlaylist) {
                await api.removeVideoFromPlaylist(ch.value, currentVideo.id);
            }
        }


        playlistContainer.style.display = "none";
        await refreshPlaylists();
        updatePlayerPlaylist();


        alert("Изменения сохранены!");
    });

    editPlaylistsBtn.addEventListener("click", openPlaylistEditor);

    document.body.addEventListener("click", (e) => {
        if (!started) return;
        if (!e.target.closest(".button") &&
            !e.target.closest(".fullscreen-btn") &&
            !e.target.closest("#playlistSelect") &&
            !e.target.closest(".newPlaylistName") &&
            !e.target.closest(".createPlaylistBtn")) {
            player.togglePause(bgVideo, audio);
        }
    });
}

init();