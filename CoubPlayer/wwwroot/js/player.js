//player.js
export class Player {

    constructor(players, audio, bgVideo) {
        this.players = players;
        this.audio = audio;
        this.bgVideo = bgVideo;

        this.active = 0;
        this.next = 1;
        this.index = 0;
        this.playlist = [];
    }

    setPlaylist(list) {
        this.playlist = list;
    }

    play(indexToPlay) {

        if (indexToPlay < 0 || indexToPlay >= this.playlist.length) return;

        this.index = indexToPlay;

        const item = this.playlist[this.index];
        const player = this.players[this.active];

        player.src = item.video;
        this.audio.src = item.audio;
        this.bgVideo.src = item.video;

        player.play();
        this.audio.play().catch(() => { });
        this.bgVideo.play().catch(() => { });
    }

    nextVideo() {
        this.switchVideo(this.index + 1);
    }

    prevVideo() {
        this.switchVideo(this.index - 1);
    }

    switchVideo(newIndex) {

        if (newIndex < 0 || newIndex >= this.playlist.length) return;

        const newItem = this.playlist[newIndex];
        const player = this.players[this.next];

        player.src = newItem.video;
        this.audio.src = newItem.audio;

        this.players[this.active].pause();
        this.players[this.active].style.display = "none";

        player.style.display = "block";

        player.play();
        this.audio.play().catch(() => { });

        this.bgVideo.src = newItem.video;
        this.bgVideo.play().catch(() => { });

        [this.active, this.next] = [this.next, this.active];

        this.index = newIndex;
    }

    togglePause(bgVideo, audio) {
        const video = this.players[this.active];
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
}