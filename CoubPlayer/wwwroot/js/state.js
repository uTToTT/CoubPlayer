// state.js
// Централизованное хранилище состояния приложения.
// Поля помеченные в PERSIST_KEYS сохраняются в localStorage и восстанавливаются при старте.

const STORAGE_KEY = "coub_player_state";

// Только эти поля персистим — playlists и coubMap не нужны (они с сервера)
const PERSIST_KEYS = ["selectedPlaylist", "sortType", "sortDirection", "randomSeed", "volume", "videoIndex"];



function loadPersistedState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function saveState(current) {
    try {
        const toSave = {};
        for (const key of PERSIST_KEYS) toSave[key] = current[key];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {
        // localStorage может быть недоступен — не критично
    }
}

const persisted = loadPersistedState();

const _state = {
    playlists: {},
    coubMap: {},
    selectedPlaylist: persisted.selectedPlaylist ?? null,
    sortType: persisted.sortType ?? "order",
    sortDirection: persisted.sortDirection ?? "asc",
    randomSeed: persisted.randomSeed ?? 42,
    volume: persisted.volume ?? 50,
    videoIndex: persisted.videoIndex ?? 0,
};

export const state = new Proxy(_state, {
    set(target, key, value) {
        target[key] = value;
        if (PERSIST_KEYS.includes(key)) saveState(target);
        return true;
    },
});