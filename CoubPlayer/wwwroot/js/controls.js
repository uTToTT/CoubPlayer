// controls.js
// Keyboard, wheel, кнопки. Работает только через публичный API Player.
// Больше не лезет напрямую в player.videoEls[player.activeIdx].

/**
 * @param {import("./player.js").Player} player
 */
export function initControls(player) {
    const nextBtn = document.getElementById("next");
    const prevBtn = document.getElementById("prev");
    const restartBtn = document.getElementById("restart");
    const fullscreenBtn = document.getElementById("fullscreen");

    nextBtn.onclick = () => player.goToNext();
    prevBtn.onclick = () => player.goToPrev();
    restartBtn.onclick = () => player.restart();
    fullscreenBtn.onclick = toggleFullscreen;

    document.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") player.goToNext();
        if (e.key === "ArrowLeft") player.goToPrev();

        if (e.code === "Space") {
            e.preventDefault();
            player.togglePause();
        }

        if (e.key === "r" || e.key === "R") {
            player.restart();
        }
    });

    // Колесо мыши с debounce.
    // Не перелистываем если курсор над скроллируемым списком (панели плейлистов).
    const SCROLL_SELECTORS = [".pl-editor-list", ".pl-editor-overlay"];

    const isOverScrollable = (target) =>
        SCROLL_SELECTORS.some((sel) => target.closest(sel));

    let wheelLock = false;
    document.addEventListener("wheel", (e) => {
        if (isOverScrollable(e.target)) return;
        if (wheelLock) return;
        wheelLock = true;
        setTimeout(() => (wheelLock = false), 25);

        if (e.deltaY > 0) {
            player.goToNext();
        } else {
            player.goToPrev();
        }
    });
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.body.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}
