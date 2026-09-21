// messages.js
// Имена сообщений между popup / content script / service worker.
//
// Content script подключается классическим скриптом (не модулем), поэтому
// импортировать этот файл он не может и пишет те же строки литералами —
// они помечены комментарием «см. messages.js».

export const MSG = {
    /** popup → sw: жив ли локальный CoubPlayer, какие у него плейлисты */
    PING: "ping",

    /** popup → sw: что расширение видит в куках coub.com (диагностика) */
    COOKIES: "cookies",

    /** popup → sw: перебрать все способы запроса и показать, что ответил API */
    PROBE: "probe",

    /** popup → sw → content → page-probe: что вызывала сама страница coub.com */
    PAGE_REQUESTS: "pageRequests",

    /** content → sw: скачать один куб по permalink */
    DOWNLOAD_ONE: "downloadOne",

    /** content → sw: плейлисты для меню кнопки, с пометкой «уже здесь» */
    PLAYLISTS: "playlists",

    /** content → sw: завести новый плейлист прямо из меню */
    CREATE_PLAYLIST: "createPlaylist",

    /** content → sw: какие из этих роликов уже в библиотеке */
    LIBRARY: "library",

    /** content → sw: куда этот ролик просится (подсказки по тегам) */
    SUGGEST: "suggest",

    /** popup → sw: собрать ленту, вычесть скачанное, отдать остаток серверу */
    SYNC: "sync",

    /** popup → sw: пройти ленту и расставить плейлист в её порядке */
    ALIGN: "align",

    /** popup → sw: прервать текущую загрузку */
    STOP: "stop",

    /** sw → content: сходить в API coub.com со страницы (см. relay в coub-api.js) */
    COUB_FETCH: "coubFetch",

    /** popup → sw: что сейчас происходит (попап могли только что открыть) */
    JOB: "job",

    /** sw → popup: ход выполнения долгой операции */
    PROGRESS: "progress",
};

/** Категории лент, они же имена плейлистов на стороне CoubPlayer. */
export const CATEGORIES = ["liked", "bookmarks"];
