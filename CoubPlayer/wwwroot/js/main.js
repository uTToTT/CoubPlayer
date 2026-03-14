//main.js
import { loadData } from "./loader.js";
import { buildPlaylist } from "./playlist.js";
import { Player } from "./player.js";
import { initControls } from "./controls.js";

const players = [
    document.getElementById("playerA"),
    document.getElementById("playerB")
];

const audio = document.getElementById("audio");
const bgVideo = document.getElementById("bgVideo");
const playlistSelect = document.getElementById("playlistSelect");

const player = new Player(players, audio, bgVideo);

let started = false;
let playlistsData = {};
let coubMapData = {};

async function init() {

    const { playlists, coubMap } = await loadData();
    playlistsData = playlists;
    coubMapData = coubMap;

    initControls(player, bgVideo, audio);

    for (const name of Object.keys(playlists)) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        playlistSelect.appendChild(option);
    }

    playlistSelect.addEventListener("change", () => {
        const selected = playlistSelect.value;
        if (!selected) return;

        const playlist = buildPlaylist(playlistsData, coubMapData, selected);
        player.setPlaylist(playlist);
        player.play(0);

        started = true;
    });

    document.body.addEventListener("click", (e) => {

        if (!started) return;
        if (!e.target.closest(".button") && !e.target.closest(".fullscreen-btn") && !e.target.closest("#playlistSelect")) {
            player.togglePause(bgVideo, audio);
        }

    });

}

init();