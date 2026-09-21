// controls.js
// Keyboard, wheel, кнопки. Работает только через публичный API Player.
// Больше не лезет напрямую в player.videoEls[player.activeIdx].
//
// В режиме «плитка» плеер выключен целиком, поэтому управление
// воспроизведением там не работает — иначе стрелки и колесо снова
// запускали бы ролик, который пользователь не видит.

import { isGridMode } from "./grid.js";

/**
 * @param {import("./player.js").Player} player
 */
export function initControls(player, setVolumeSlider, onToggleEditor) {
    const nextBtn = document.getElementById("next");
    const prevBtn = document.getElementById("prev");
    const restartBtn = document.getElementById("restart");
    const fullscreenBtn = document.getElementById("fullscreen");

    nextBtn.onclick = () => { player.goToNext(); nextBtn.blur(); };
    prevBtn.onclick = () => { player.goToPrev(); prevBtn.blur(); };
    restartBtn.onclick = () => { player.restart(); restartBtn.blur(); };
    fullscreenBtn.onclick = () => { toggleFullscreen(); fullscreenBtn.blur(); };

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) return;

        // Громкость настраивается и в плитке — ей управляют превью
        const playbackOff = isGridMode();

        switch (e.code) {
            case "ArrowRight":
                if (playbackOff) return;
                player.goToNext();
                break;
            case "ArrowLeft":
                if (playbackOff) return;
                player.goToPrev();
                break;
            case "ArrowUp": {
                e.preventDefault();
                const volUp = Math.min(100, player.getVolume() + 5);
                player.setVolume(volUp);
                setVolumeSlider(volUp);
                break;
            }
            case "ArrowDown": {
                e.preventDefault();
                const volDown = Math.max(0, player.getVolume() - 5);
                player.setVolume(volDown);
                setVolumeSlider(volDown);
                break;
            }
            case "Numpad0":
            case "KeyR":
                if (playbackOff) return;
                player.restart();
                break;
            case "Space":
                e.preventDefault();
                if (playbackOff) return;
                player.togglePause();
                break;
            // case "ControlRight":
            //     e.preventDefault();
            //     onToggleEditor();
            //     break;
        }
    });

    // Места, где колесо — это прокрутка списка, а не переключение ролика.
    // Список ведётся вручную: всплывающие окна лежат в body, а не внутри
    // плеера, и по дереву их родство не определить
    const SCROLL_SELECTORS = [
        ".pl-editor-list",
        ".pl-editor-overlay",
        ".grid-view",
        ".coub-picker-overlay",
    ];
    const isOverScrollable = (target) =>
        SCROLL_SELECTORS.some((sel) => target.closest(sel));

    let wheelLock = false;
    document.addEventListener("wheel", (e) => {
        if (isGridMode()) return;
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
