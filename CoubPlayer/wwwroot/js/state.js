// state.js
// Централизованное хранилище состояния приложения.
// Поля помеченные в PERSIST_KEYS сохраняются в localStorage и восстанавливаются при старте.

const STORAGE_KEY = "coub_player_state";

// Только эти поля персистим — playlists и coubMap не нужны (они с сервера)
const PERSIST_KEYS = ["selectedPlaylist", "sortType", "sortDirection", "randomSeed", "volume", "lastVideoByPlaylist", "coubAccessToken"];

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
    // { [playlistId]: coubId } — последний просмотренный ролик для каждого плейлиста отдельно
    lastVideoByPlaylist: persisted.lastVideoByPlaylist ?? {},
    // remember_token из cookie авторизованной сессии coub.com — нужен только для докачки liked/bookmarks.
    // Хранится локально в браузере, на сервер уходит лишь в теле запроса /api/playlists/sync
    coubAccessToken: persisted.coubAccessToken ?? null,
};

export const state = new Proxy(_state, {
    set(target, key, value) {
        target[key] = value;
        if (PERSIST_KEYS.includes(key)) saveState(target);
        return true;
    },
});

/**
 * Запоминает последний ролик для конкретного плейлиста.
 * lastVideoByPlaylist — объект, поэтому мутировать его "на месте" нельзя:
 * Proxy отслеживает только присваивание в state.<key>, а не изменение
 * содержимого вложенного объекта. Поэтому пересобираем объект целиком
 * и переприсваиваем — это гарантированно сохранится в localStorage.
 */
export function setLastVideoForPlaylist(playlistId, coubId) {
    if (playlistId == null || coubId == null) return;
    state.lastVideoByPlaylist = {
        ...state.lastVideoByPlaylist,
        [playlistId]: coubId,
    };
}

/**
 * Возвращает id последнего просмотренного ролика для плейлиста,
 * либо null, если для него ещё ничего не сохранено.
 */
export function getLastVideoForPlaylist(playlistId) {
    if (playlistId == null) return null;
    return state.lastVideoByPlaylist[playlistId] ?? null;
}