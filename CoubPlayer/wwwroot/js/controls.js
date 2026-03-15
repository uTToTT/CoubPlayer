//controls.js
export function initControls(player, bgVideo, audio) {

    let wheelLock = false;

    const nextBtn = document.getElementById("next");
    const prevBtn = document.getElementById("prev");
    const restartBtn = document.getElementById("restart");
    const fullscreenBtn = document.getElementById("fullscreen");

    nextBtn.onclick = () => player.nextVideo();
    prevBtn.onclick = () => player.prevVideo();

    restartBtn.onclick = () => restart(player, bgVideo, audio);

    fullscreenBtn.onclick = toggleFullscreen;

    document.addEventListener("keydown", (e) => {

        if (e.key === "ArrowRight") player.nextVideo();
        if (e.key === "ArrowLeft") player.prevVideo();

        if (e.code === "Space") {
            e.preventDefault();
            togglePause(player, bgVideo, audio);
        }

        if (e.key === "r" || e.key === "R") {
            restart(player, bgVideo, audio);
        }

    });

    document.addEventListener("wheel", (e) => {

        if (wheelLock) return;

        wheelLock = true;

        setTimeout(() => wheelLock = false, 25);

        if (e.deltaY > 0) {
            player.nextVideo();
        } else {
            player.prevVideo();
        }

    });
}

function togglePause(player, bgVideo, audio) {

    const video = player.players[player.active];

    if (video.paused) {

        video.play();
        bgVideo.play();
        audio.play().catch(() => { });

    } else {

        video.pause();
        bgVideo.pause();
        audio.pause();

    }

}

function restart(player, bgVideo, audio) {

    const video = player.players[player.active];

    video.currentTime = 0;
    bgVideo.currentTime = 0;
    audio.currentTime = 0;

    video.play();
    bgVideo.play();
    audio.play().catch(() => { });

}

function toggleFullscreen() {

    if (!document.fullscreenElement) {
        document.body.requestFullscreen();
    } else {
        document.exitFullscreen();
    }

}