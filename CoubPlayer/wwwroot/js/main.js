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
const playlistCheckboxes = document.getElementById("playlistCheckboxes");

const editPlaylistsBtn = document.getElementById("editPlaylistsBtn");
const playlistContainer = document.getElementById("playlistCheckboxesContainer");
const savePlaylistsBtn = document.getElementById("savePlaylistsBtn");

const sortTypeGroup = document.getElementById("sortTypeGroup");
const sortDirectionBtn = document.getElementById("sortDirectionBtn");

const seedInput = document.getElementById("seedInput");

const videoTitleLabel = document.getElementById("videoTitleLabel");
const copyLinkBtn = document.getElementById("copyLinkBtn");

let sortType = "order";  // order или lastViewed
let sortDirection = "asc"; // asc или desc

const player = new Player(players, audio, bgVideo, (videoItem) => {
    if (videoItem && videoItem.title) {
        videoTitle.textContent = videoItem.title;
    } else {
        videoTitle.textContent = "";
    }
});

const state = {
    playlists: {},
    coubMap: {}
};

let started = false;

let currentPlaylistObj = null;

async function applySorting() {

    if (!playlistSelect.value) return;

    await reloadPlaylists();

    const playlistName = playlistSelect.value;
    currentPlaylistObj = state.playlists[playlistName];

    if (!currentPlaylistObj) return;

    let ordered = [];

    console.log("Sort:", sortType, sortDirection);

    if (sortType === "order") {
        ordered = player.buildOrderedPlaylistByOrder(
            currentPlaylistObj,
            sortDirection
        );
    }
    else if (sortType === "lastViewed") {
        ordered = player.buildOrderedPlaylistByDate(
            currentPlaylistObj,
            sortDirection
        );
    }
    else if (sortType === "random") {

        const seed = parseInt(seedInput.value) || 1;

        ordered = player.buildRandomPlaylist(
            currentPlaylistObj,
            seed
        );
    }

    ordered = ordered.map(item => {
        const coubData = state.coubMap[item.id] || {};
        return {
            id: item.id,
            title: item.title,
            video: coubData.video || "",
            audio: coubData.audio || "",
            lastViewed: item.lastViewed || null
        };
    });

    player.setPlaylist(ordered, playlistName);
    player.play(0);
}

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

        checkbox.checked = !!state.playlists[name].videos[currentVideo.id];

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + name));

        playlistCheckboxes.appendChild(label);
    }

    playlistContainer.style.display = "block";
}


async function saveCurrentVideoPlaylists() {
    const currentVideo = player.playlist[player.index];
    if (!currentVideo) return;

    const checkboxes = playlistCheckboxes.querySelectorAll("input[type=checkbox]");

    for (const ch of checkboxes) {
        const exists = state.playlists[ch.value].videos[currentVideo.id];

        if (ch.checked && !exists) {
            await addVideoReactive(ch.value, currentVideo);
        } else if (!ch.checked && exists) {
            await removeVideoReactive(ch.value, currentVideo.id);
        }
    }

    playlistContainer.style.display = "none";
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

    playlistSelect.innerHTML = "";

    for (const name of Object.keys(state.playlists)) {
        const option = document.createElement("option");
        const videoCount = Object.keys(state.playlists[name].videos || {}).length;
        option.value = name;
        option.textContent = `${name}  (${videoCount})`;
        playlistSelect.appendChild(option);
    }

    const newOption = document.createElement("option");
    newOption.value = "__new__";
    newOption.textContent = "+ Create new playlist";
    playlistSelect.appendChild(newOption);
}

async function init() {
    const data = await loadData();

    state.playlists = data.playlists;
    state.coubMap = data.coubMap;

    renderPlaylistsUI();
    initControls(player, bgVideo, audio);

    let defaultPlaylist = null;
    if (state.playlists["bookmarks"]) {
        defaultPlaylist = "bookmarks";
    } else if (state.playlists["liked"]) {
        defaultPlaylist = "liked";
    } else {
        const keys = Object.keys(state.playlists);
        if (keys.length > 0) defaultPlaylist = keys[0];
    }

    if (defaultPlaylist) {
        playlistSelect.value = defaultPlaylist;
        playlistSelect.dataset.prevSelection = defaultPlaylist;

        currentPlaylistObj = state.playlists[defaultPlaylist];
        const orderedPlaylist = player.buildOrderedPlaylistByOrder(currentPlaylistObj).map(item => {
            const coubData = state.coubMap[item.id] || {};
            return {
                id: item.id,
                title: item.title,
                video: coubData.video || "",
                audio: coubData.audio || ""
            };
        });

        if (orderedPlaylist.length) {
            player.setPlaylist(orderedPlaylist, defaultPlaylist);
            player.play(0);
            player.pauseCurrent();
            started = true;
        }
    }

    playlistSelect.addEventListener("change", async () => {
        const selected = playlistSelect.value;

        if (selected === "__new__") {
            const name = prompt("Enter new playlist name:");
            if (!name) {
                playlistSelect.value = playlistSelect.dataset.prevSelection || "";
                return;
            }

            await api.createPlaylist({ name });

            state.playlists[name] = {
                title: name,
                videos: {}
            };

            const prevSelection = playlistSelect.dataset.prevSelection || "";

            renderPlaylistsUI();

            playlistSelect.value = prevSelection;

            return;
        }

        if (!selected) return;

        playlistSelect.dataset.prevSelection = selected;

        await reloadPlaylists();

        const playlistObj = state.playlists[selected];
        if (!playlistObj || !playlistObj.videos) {
            alert("Playlist empty!");
            return;
        }

        currentPlaylistObj = playlistObj;

        const orderedPlaylist = player.buildOrderedPlaylistByOrder(playlistObj).map(item => {
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

        player.setPlaylist(orderedPlaylist, selected);
        player.play(0);
        started = true;
    });

    savePlaylistsBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await saveCurrentVideoPlaylists();
    });

    editPlaylistsBtn.addEventListener("click", openPlaylistEditor);

    document.addEventListener("click", async (e) => {
        if (playlistContainer.style.display !== "block") return;

        const isClickInside = e.target.closest("#playlistCheckboxesContainer") ||
            e.target.closest("#editPlaylistsBtn");

        if (!isClickInside) {
            await saveCurrentVideoPlaylists();
        }
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

    sortTypeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;

        // UI
        [...sortTypeGroup.children].forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        sortType = btn.dataset.type;

        // UX: seed только для random
        seedInput.classList.toggle("hidden", sortType !== "random");

        applySorting();
    });

    sortDirectionBtn.addEventListener("click", () => {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";

        sortDirectionBtn.textContent = sortDirection === "asc" ? "↑" : "↓";

        applySorting();
    });

    videoIndexInput.addEventListener("input", () => {
        player.goToIndex(videoIndexInput.value);
    });

    player.onVideoChange = () => {
        const currentVideo = player.playlist[player.index];
        if (!currentVideo) return;

        videoTitleLabel.textContent = player.index + 1 + ". " + currentVideo.title || "-";

        const checkboxes = playlistCheckboxes.querySelectorAll("input[type=checkbox]");
        checkboxes.forEach(ch => {
            ch.checked = !!state.playlists[ch.value].videos[currentVideo.id];
        });
    };

    copyLinkBtn.addEventListener("click", async () => {
        const currentVideo = player.playlist[player.index];
        if (!currentVideo) return;

        const url = `https://coub.com/view/${currentVideo.id}`;

        try {
            await navigator.clipboard.writeText(url);
            copyLinkBtn.textContent = "Copied!";
            setTimeout(() => {
                copyLinkBtn.textContent = "Copy link";
            }, 1000);
        } catch (e) {
            console.error("Clipboard error:", e);
        }
    });

    players.forEach((video, i) => {
        video.addEventListener("play", () => console.log(`VIDEO ${i} play`));
        video.addEventListener("pause", () => console.log(`VIDEO ${i} pause`));
    });

    bgVideo.addEventListener("play", () => console.log("BG play"));
    bgVideo.addEventListener("pause", () => console.log("BG pause"));
}

init();