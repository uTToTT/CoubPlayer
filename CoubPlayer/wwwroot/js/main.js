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

const sortAscBtn = document.getElementById("sortAscBtn");
const sortDescBtn = document.getElementById("sortDescBtn");

const player = new Player(players, audio, bgVideo);
const state = {
    playlists: {},
    coubMap: {}
};

let started = false;

let currentPlaylistObj = null;

async function reloadPlaylists() {
    const data = await loadData();
    state.playlists = data.playlists;
    state.coubMap = data.coubMap;
}

async function openPlaylistEditor() {

    const currentVideo = player.playlist[player.index];
    if (!currentVideo) return alert("Нет текущего видео!");

    playlistCheckboxes.innerHTML = "";

    for (const name of Object.keys(state.playlists)) {

        const label = document.createElement("label");
        label.style.display = "block";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = name;

        if (state.playlists[name].videos[currentVideo.id]) {
            checkbox.checked = true;
        }

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + name));

        playlistCheckboxes.appendChild(label);
    }

    playlistContainer.style.display = "block";
}

async function removeVideoReactive(playlist, videoId) {

    await api.removeVideoFromPlaylist(playlist, videoId);

    delete state.playlists[playlist].videos[videoId];
}

async function addVideoReactive(playlist, video) {

    await api.addVideoToPlaylist(
        playlist,
        video.id,
        video.title
    );

    state.playlists[playlist].videos[video.id] = {
        title: video.title
    };
}

function renderPlaylistsUI() {

    playlistCheckboxes.innerHTML = "";
    for (const name of Object.keys(state.playlists)) {

        const label = document.createElement("label");
        label.style.display = "block";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = name;

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + name));

        playlistCheckboxes.appendChild(label);
    }

    playlistSelect.innerHTML = '<option value="">Choose playlist</option>';

    for (const name of Object.keys(state.playlists)) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        playlistSelect.appendChild(option);
    }
}

async function init() {
    const data = await loadData();

    state.playlists = data.playlists;
    state.coubMap = data.coubMap;

    renderPlaylistsUI();
    initControls(player, bgVideo, audio);

    playlistSelect.addEventListener("change", async () => {
        const selected = playlistSelect.value;
        if (!selected) return;

        // подгружаем свежие данные
        await reloadPlaylists();

        const playlistObj = state.playlists[selected];
        if (!playlistObj || !playlistObj.videos) {
            alert("Playlist empty!");
            return;
        }

        currentPlaylistObj = playlistObj;

        const orderedPlaylist = player.buildOrderedPlaylist(playlistObj).map(item => {
            const coubData = state.coubMap[item.id] || {};
            return {
                id: item.id,
                title: item.title,
                video: coubData.video || "",
                audio: coubData.audio || ""
            };
        });

        if (!orderedPlaylist.length) {
            alert("Playlist empty!");
            return;
        }

        player.setPlaylist(orderedPlaylist);
        player.play(0);

        started = true;
    });


    createPlaylistBtn.addEventListener("click", async () => {

        const name = newPlaylistInput.value.trim();
        if (!name) return;

        await api.createPlaylist({ name });

        state.playlists[name] = {
            title: name,
            videos: {}
        };

        renderPlaylistsUI();

        newPlaylistInput.value = "";
    });

    // сохранить изменения
    savePlaylistsBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const currentVideo = player.playlist[player.index];
        if (!currentVideo) return alert("Нет текущего видео!");

        const checkboxes =
            playlistCheckboxes.querySelectorAll("input[type=checkbox]");

        for (const ch of checkboxes) {
            const exists = state.playlists[ch.value].videos[currentVideo.id];

            if (ch.checked && !exists) {
                await addVideoReactive(ch.value, currentVideo);
            } else if (!ch.checked && exists) {
                await removeVideoReactive(ch.value, currentVideo.id);
            }
        }

        playlistContainer.style.display = "none";
    });

    editPlaylistsBtn.addEventListener("click", openPlaylistEditor);
    cancelPlaylistsBtn.addEventListener("click", () => {
        playlistContainer.style.display = "none";
    });
    window.addEventListener("beforeunload", () => {
        console.log("PAGE RELOAD");
    });
    document.addEventListener("submit", (e) => {
        e.preventDefault();
    });
    document.body.addEventListener("click", (e) => {
        if (!started) return;
        if (!e.target.closest(".button") &&
            !e.target.closest(".fullscreen-btn") &&
            !e.target.closest("#playlistSelect") &&
            !e.target.closest("#playlistCheckboxesContainer") &&
            !e.target.closest("#newPlaylistName") &&
            !e.target.closest("#createPlaylistBtn")) {

            player.togglePause(bgVideo, audio);
        }
    });

    sortAscBtn.addEventListener("click", () => {
        if (!currentPlaylistObj) return;
        const ordered = player.buildOrderedPlaylist(currentPlaylistObj, 'asc').map(item => {
            const coubData = state.coubMap[item.id] || {};
            return {
                id: item.id,
                title: item.title,
                video: coubData.video || "",
                audio: coubData.audio || ""
            };
        });

        player.setPlaylist(ordered);
        player.play(0);
    });

    sortDescBtn.addEventListener("click", () => {
        if (!currentPlaylistObj) return;
        const ordered = player.buildOrderedPlaylist(currentPlaylistObj, 'desc').map(item => {
            const coubData = state.coubMap[item.id] || {};
            return {
                id: item.id,
                title: item.title,
                video: coubData.video || "",
                audio: coubData.audio || ""
            };
        });

        player.setPlaylist(ordered);
        player.play(0);
    });
}

init();