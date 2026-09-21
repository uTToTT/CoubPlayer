// grid.js — режим просмотра плейлиста плиткой.
//
// Это не модалка, а второй основной вид: тело получает класс view-grid,
// плеерная обвязка (само видео, стрелки, таймлайн, счётчик) прячется,
// сетка занимает её место. Плеер при этом продолжает играть — переключение
// вида не трогает воспроизведение.
//
// Сетка показывает ровно тот список, который загружен в плеер (уже
// отсортированный и отфильтрованный по тегам), поэтому индексы плиток
// совпадают с индексами player.playlist.
//
// В дереве живут только плитки рядом с видимой областью — см. «Окно
// отрисовки» ниже. Плейлист может быть на восемь тысяч роликов, но узлов
// от этого больше сотни-другой не становится.
//
// В покое плитка показывает снятый кадр — картинку в 10 КБ (см. thumbs.js).
// Видео заводится только под курсором: один декодер вместо трёх десятков.
// У роликов, для которых кадра ещё нет, всё как раньше — видео грузится,
// когда плитка попала во вьюпорт, и заодно с него снимается кадр. Так
// библиотека обрастает кадрами сама, по мере просмотра.
//
// Выделение: чекбокс в углу плитки, Ctrl+клик (переключить) и Shift+клик
// (диапазон). Пока что-то выделено, обычный клик тоже переключает выделение,
// а перейти к ролику можно двойным кликом. Над выделенным набором работают
// массовые действия — добавить всё в плейлист или навесить тег.
//
// Порядок роликов меняется перетаскиванием плиток — доступно только когда
// сетка показывает плейлист в его собственном порядке (сортировка Order).

import { showToast, isMadnessPanelOpen } from "./ui.js";
import { composeSettings } from "./randomizer.js";
import { coubIdFromKey } from "./playlist.js";
import { primeThumbs, thumbsReady, hasThumb, thumbUrl, captureThumb } from "./thumbs.js";
import { filterByQuery } from "./search.js";
import { getCoubChannels } from "./api.js";

const TILE_MIN_PX = { s: 140, m: 220, l: 320 };

const DRAG_SCROLL_ZONE = 70; // px от края списка, где начинается автоскролл

const gridView = document.getElementById("gridView");
const subtitle = document.getElementById("gridSubtitle");
const search = document.getElementById("gridSearch");
const searchClear = document.getElementById("gridSearchClear");
const semanticBtn = document.getElementById("gridSemanticBtn");
const list = document.getElementById("gridList");
const sizeGroup = document.getElementById("gridSizeGroup");
const viewModeGroup = document.getElementById("viewModeGroup");

const bulkBar = document.getElementById("gridBulkBar");
const bulkCount = document.getElementById("gridBulkCount");
const bulkAllBtn = document.getElementById("gridBulkAll");
const bulkClearBtn = document.getElementById("gridBulkClear");
const bulkPlaylistBtn = document.getElementById("gridBulkPlaylist");
const bulkTagBtn = document.getElementById("gridBulkTag");
const bulkPresetBtn = document.getElementById("gridBulkPreset");

const popover = document.getElementById("gridBulkPopover");
const popoverTitle = document.getElementById("gridBulkPopoverTitle");
const popoverClose = document.getElementById("gridBulkPopoverClose");
const popoverList = document.getElementById("gridBulkPopoverList");
const popoverInput = document.getElementById("gridBulkInput");
const popoverAddBtn = document.getElementById("gridBulkInputAdd");

// Плейлисты, которыми управляет не пользователь, а синхронизация/само приложение
const BULK_EXCLUDED_PLAYLISTS = ["Все", "bookmarks", "liked"];

let _getItems = () => [];
let _getCurrentIndex = () => -1;
let _getPlaylistName = () => null;
let _onPick = null;
let _onTileSizeChange = null;
let _onViewModeChange = null;
let _getVolume = () => 50;
let _onPreviewActive = null;
let _getPlaylists = () => ({});
let _onCreatePlaylist = null;
let _onBulkAddToPlaylist = null;
let _getAllTags = () => [];
let _onBulkAddTag = null;
let _getPresets = () => [];
let _onBulkApplyPreset = null;
let _getReorderInfo = () => ({ enabled: false, hint: "" });
let _onReorder = null;
let _onPlayerActive = null;
let _onBgPreview = null;

// Снимок плейлиста: [{ item, index }], index — позиция в player.playlist
let _entries = [];
let _filtered = [];
let _entryById = new Map();
let _tileSize = "m";
let _viewMode = "list";

const _selected = new Set(); // ключи записей выделенных роликов
let _anchorPos = null;       // позиция в _filtered для Shift-диапазона
let _bulkMode = null;        // null | "playlist" | "tag"
let _bulkBusy = false;

let _dragTile = null;
let _reorderEnabled = false;

// ─── Звук превью ──────────────────────────────────────────────────────────
// Один общий audio-элемент: одновременно проигрывается только одна плитка.
// Основной плеер на это время приглушается через _onPreviewActive, иначе
// две дорожки играли бы одна поверх другой.

const previewAudio = new Audio();
previewAudio.loop = true;
let _previewVideo = null;

function startPreview(video, item) {
    if (_dragTile) return; // во время перетаскивания превью только мешают
    stopPreview();
    _previewVideo = video;

    if (video.dataset.loaded === "1") video.play().catch(() => { });

    // Фон повторяет тот ролик, который сейчас смотрят
    _onBgPreview?.(video, item);

    if (item.audio) {
        _onPreviewActive?.(true);
        previewAudio.src = item.audio;
        previewAudio.volume = Math.max(0, Math.min(1, _getVolume() / 100));
        previewAudio.currentTime = 0;
        previewAudio.play().catch(() => { });
    }
}

function stopPreview() {
    if (_previewVideo) _onBgPreview?.(null, null);
    if (_previewVideo) {
        _previewVideo.pause();
        try { _previewVideo.currentTime = 0.1; } catch { /* метаданные ещё не готовы */ }
        _previewVideo = null;
    }
    if (previewAudio.hasAttribute("src")) {
        previewAudio.pause();
        previewAudio.removeAttribute("src");
        previewAudio.load(); // отпускаем скачанный mp3
    }
    _onPreviewActive?.(false);
}

/**
 * Замер отзывчивости сетки: сколько плиток в дереве, сколько видеоэлементов
 * и сколько кадров в секунду выходит, пока идёт прокрутка.
 *
 * Живёт в самом плеере, а не подсказкой «вставьте это в консоль»: браузер
 * такую вставку справедливо не пускает, а набирать руками длинную строку —
 * то ещё занятие. Здесь достаточно набрать coubStats().
 *
 * Ничего не меняет и ни на что не влияет — только считает.
 */
window.coubStats = function coubStats(seconds = 5) {
    const started = performance.now();
    let frames = 0;

    const tick = () => {
        frames++;
        if (performance.now() - started < seconds * 1000) requestAnimationFrame(tick);
        else report();
    };

    const report = () => {
        const elapsed = (performance.now() - started) / 1000;
        const stats = {
            "роликов в списке": _filtered.length,
            "плиток в дереве": list.querySelectorAll(".coub-tile").length,
            "с готовым кадром": list.querySelectorAll(".coub-tile-still").length,
            "подключено видео": list.querySelectorAll('video[data-loaded="1"]').length,
            "кадров в секунду": Math.round(frames / elapsed),
            "окно с позиции": _first,
            "колонок в ряду": _cols,
        };
        console.table(stats);
        return stats;
    };

    requestAnimationFrame(tick);
    return `Считаю ${seconds} с — крутите колесом. Результат появится здесь же.`;
};

/**
 * Затемнение соседей, пока курсор на плитке.
 *
 * Раньше условием был селектор :has() на самой сетке — и это оказалось
 * дорого: браузер пересчитывает всё поддерево контейнера при каждом движении
 * курсора между плитками, а их бывает несколько тысяч. Класс, поставленный
 * из кода, такого пересчёта не вызывает.
 *
 * Раньше на длинных списках затемнение выключалось совсем: правило действует
 * сразу на все плитки, а их было ровно столько же, сколько роликов. С окном
 * отрисовки в дереве сотня-другая плиток при любой длине списка — отключать
 * больше нечего.
 */
function setFocusing(on) {
    list.classList.toggle("is-focusing", on);
}

// ─── Смысловой поиск ──────────────────────────────────────────────────────
// Второй режим поля поиска: искать не по словам названия, а по тому, что
// видно на кадре. «Небо и облака» находит небо, даже если ролик называется
// «xd228» и тегов у него нет.
//
// Устроено иначе, чем обычный поиск, и в двух местах сразу:
//
//   • запрос считает модель в браузере, а сравнивает векторы сервер — это
//     треть секунды на запрос, поэтому не на каждую букву, а по Enter
//     или через паузу в наборе;
//   • порядок выдачи задаёт сервер, по близости, и трогать его нельзя:
//     в нём вся суть.
//
// Модель качается один раз и живёт в кэше браузера. Первый запрос за сеанс
// поэтому долгий — об этом честно пишем в подписи, а не молчим.

const SEMANTIC_DEBOUNCE_MS = 700;
const SEMANTIC_LIMIT = 200;

// Отсечки для поиска фразой. Взяты с замеров на живой библиотеке, а не из
// головы. Последний замер — уже на пяти кадрах с ролика: у восьми запросов,
// которым в библиотеке есть что показать, лучшая оценка выходила 0.021…0.078,
// у пятнадцати заведомо отсутствующих — от -0.028 до 0.031.
//
// Чистой границы между ними нет и быть не может: оценки SigLIP не
// откалиброваны, и сравнивать их с постоянным числом можно только грубо.
// Диапазоны заметно перекрываются, и 0.03 — не граница, а место, где ошибок
// меньше всего: выше него оказались шесть присутствующих запросов из восьми
// и один отсутствующий из пятнадцати. Поэтому отсечка ничего не прячет
// молча, а лишь решает, показывать ли оговорку.
//
// Ноль — единственная осмысленная граница: ниже неё кадр и фраза смотрят
// в разные стороны, и такие ролики в выдаче только мешают.
const RELEVANT = 0;
const CONFIDENT = 0.03;

/** Сколько показать, когда верить нечему: пусто выглядело бы поломкой. */
const FALLBACK_SHOWN = 12;

let _semantic = false;
let _semanticBusy = false;
let _semanticTimer = null;
/** Номер запроса: ответы приходят не по порядку, старые надо отбрасывать. */
let _semanticGen = 0;

/** Пишет подпись и туда же подсказку — она длиннее, чем влезает в строку. */
function setCaption(text) {
    subtitle.textContent = text;
    subtitle.title = text;
}

function setSemanticMode(on) {
    _semantic = !!on;
    semanticBtn?.classList.toggle("is-active", _semantic);
    semanticBtn?.setAttribute("aria-pressed", String(_semantic));
    search.placeholder = _semantic
        ? "Что на кадре: «небо», «взрыв», «кот»…"
        : "Название, автор или id…";

    clearTimeout(_semanticTimer);
    if (_semantic) warmUpModel();
    applyFilter(search.value.trim());
}

/**
 * Готовит модель заранее — как только включили режим, а не когда нажали Enter.
 *
 * Текстовая башня весит 270 МБ, и её загрузка занимает секунды. Ждать их
 * после набранного запроса обиднее всего: человек уже сформулировал и ждёт
 * ответа. Пока поле пустое, ждать нечего, и это время уходит впустую —
 * туда его и переносим.
 */
async function warmUpModel() {
    try {
        const { loadText, isTextReady } = await import("./semantic.js");
        if (isTextReady()) return;

        await loadText((p) => {
            // Только пока не начали печатать: иначе сообщение о загрузке
            // затёрло бы результаты уже идущего поиска
            if (_semantic && !search.value.trim()) {
                setCaption(`Готовлю модель: ${Math.round(p.progress)}%`);
            }
        });

        if (_semantic && !search.value.trim()) updateCaption(false);
    } catch {
        // Модель не скачана — скажем об этом, когда её и правда попросят
    }
}

/**
 * Ищет по смыслу и раскладывает сетку в порядке близости.
 *
 * Искать просим только среди того, что сейчас на экране: сетка показывает
 * уже отобранное по тегам и плейлисту, и ролики вне этого набора в выдаче
 * были бы просто непонятно откуда.
 */
async function runSemanticSearch(query) {
    const gen = ++_semanticGen;
    _semanticBusy = true;

    try {
        const { loadText, embedText, isTextReady } = await import("./semantic.js");

        if (!isTextReady()) {
            setCaption("Загружаю модель — это только в первый раз…");
            await loadText((p) => {
                if (gen !== _semanticGen) return;
                setCaption(`Загружаю модель: ${Math.round(p.progress)}%`);
            });
        }
        if (gen !== _semanticGen) return;

        const vector = await embedText(query);
        if (gen !== _semanticGen) return;

        const res = await fetch("/api/embeddings/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                vector: Array.from(vector),
                limit: SEMANTIC_LIMIT,
                ids: _entries.map((e) => coubIdFromKey(e.item.key)),
            }),
        });
        if (!res.ok) throw new Error(`Поиск не удался: ${res.status}`);
        if (gen !== _semanticGen) return;

        const { results } = await res.json();
        const name = _getPlaylistName() || "—";

        if (!results.length) {
            _filtered = [];
            renderFiltered();
            setCaption(`${name} · кадры ещё не разобраны — нечего сравнивать`);
            return;
        }

        // Отбрасываем то, что смотрит в другую сторону. Раньше показывалось
        // всё подряд, просто в порядке близости, и выдача выглядела увереннее,
        // чем была: на «кошку» в библиотеке без кошек честный ответ — «нет»,
        // а не сто плиток наименее непохожего
        const top = results[0].score;
        const уверенно = top >= CONFIDENT;
        const отобранные = results.filter((r) => r.score > RELEVANT);

        const показать = отобранные.length >= 3
            ? отобранные
            : results.slice(0, FALLBACK_SHOWN);

        const rank = new Map(показать.map((r, i) => [r.id, i]));
        _filtered = _entries
            .filter((e) => rank.has(coubIdFromKey(e.item.key)))
            .sort((a, b) =>
                rank.get(coubIdFromKey(a.item.key)) - rank.get(coubIdFromKey(b.item.key)));

        renderFiltered();

        // Не «найдено N из M»: смысловой поиск не отбирает по признаку,
        // а расставляет по близости, и обещать отбор было бы неправдой
        if (уверенно) {
            setCaption(`${name} · по смыслу: «${query}», сверху ближайшие`);
        } else {
            // Подсказать про «Все» имеет смысл только если мы не в нём:
            // может, похожее в библиотеке есть, просто не в этом плейлисте
            const совет = name === "Все" ? "" : " — попробуйте плейлист «Все»";
            setCaption(`${name} · «${query}»: уверенных совпадений нет${совет}`);
        }
    } catch (err) {
        if (gen !== _semanticGen) return;
        setCaption(String(err?.message || err));
        console.warn("[Смысловой поиск]", err);
    } finally {
        if (gen === _semanticGen) _semanticBusy = false;
    }
}

/**
 * Показывает ролики, похожие на этот.
 *
 * Вектор кадра уже посчитан и лежит в базе, поэтому считать нечего и модель
 * не нужна — в отличие от поиска фразой, который сперва должен перевести
 * слова в числа. Отсюда и скорость: это обычный запрос к серверу.
 *
 * Ищем среди того же, что на экране: сетка показывает отобранное плейлистом
 * и тегами, и выдавать в ответ ролики из других плейлистов было бы
 * неожиданностью, а не помощью.
 */
async function showSimilar(coubId, title) {
    const gen = ++_semanticGen;
    setCaption("Ищу похожие…");

    try {
        const res = await fetch("/api/embeddings/similar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: coubId,
                limit: SEMANTIC_LIMIT,
                ids: _entries.map((e) => coubIdFromKey(e.item.key)),
            }),
        });
        if (!res.ok) throw new Error(`Не удалось: ${res.status}`);
        if (gen !== _semanticGen) return;

        const { results, indexed } = await res.json();
        const name = _getPlaylistName() || "—";

        if (!indexed) {
            setCaption(`${name} · кадр этого ролика ещё не разобран`);
            return;
        }

        // Отсечек, как у поиска фразой, здесь нет намеренно: там сравниваются
        // кадр с текстом и оценки жмутся к нулю, а тут кадр с кадром — и они
        // держатся в районе 0.4…0.9 просто потому, что это всё кадры.
        // Постоянное число на этой шкале не значит ничего, а порядок значит всё
        const rank = new Map(results.map((r, i) => [r.id, i]));
        _filtered = _entries
            .filter((e) => rank.has(coubIdFromKey(e.item.key)))
            .sort((a, b) =>
                rank.get(coubIdFromKey(a.item.key)) - rank.get(coubIdFromKey(b.item.key)));

        renderFiltered();
        setCaption(_filtered.length
            ? `${name} · похоже на «${title}», сверху ближайшие`
            : `${name} · похожих не нашлось`);
    } catch (err) {
        if (gen !== _semanticGen) return;
        setCaption(String(err?.message || err));
    }
}

// ─── Авторы ───────────────────────────────────────────────────────────────
// Канал ролика не приходит вместе с плейлистом — он лежит в сведениях,
// которые плеер дозагружает отдельно. Забираем их один раз на весь сеанс:
// список меняется только когда что-то скачали заново.
//
// Нужны они ради поиска: «покажи всё этого автора» — вопрос, который
// возникает ровно так же часто, как поиск по названию.

/** @type {Map<string, string>|null} id ролика → имя канала */
let _channels = null;
let _channelsLoading = null;

function channelOf(coubId) {
    return _channels?.get(coubId) || "";
}

function primeChannels() {
    if (_channels || _channelsLoading) return;

    _channelsLoading = getCoubChannels()
        .then((byChannel) => {
            _channels = new Map();
            for (const [channel, ids] of Object.entries(byChannel)) {
                for (const id of ids) _channels.set(id, channel);
            }
            // Пока список ехал, могли уже что-то искать — и искали без авторов
            if (isGridMode() && search.value.trim()) applyFilter(search.value.trim());
        })
        // Не вышло — ищем как раньше, по названию и id. Это ухудшение,
        // а не поломка, и сообщать о нём пользователю нечего
        .catch(() => { _channels = new Map(); })
        .finally(() => { _channelsLoading = null; });
}

// ─── Ленивая загрузка превью ──────────────────────────────────────────────

const mediaObserver = new IntersectionObserver(
    (records) => {
        for (const rec of records) {
            if (rec.isIntersecting) attachMedia(rec.target);
            else detachMedia(rec.target);
        }
    },
    { root: list, rootMargin: "300px 0px" }
);

function attachMedia(video) {
    if (video.dataset.loaded === "1" || !video.dataset.src) return;
    video.dataset.loaded = "1";
    // Отблеск крутится только пока плитка ждёт кадр. Оставить его на всех
    // незагруженных нельзя: в плейлисте на восемь тысяч это тысячи вечных
    // анимаций, и список начинает тормозить сам по себе.
    // Там, где кадр уже показан картинкой, ждать нечего — и отблеска не надо
    if (video.dataset.still !== "1") video.parentNode?.classList.add("is-loading");
    // Фрагмент #t=0.1 заставляет браузер отрисовать первый кадр,
    // не дожидаясь play() — это и есть наша "превьюшка".
    video.src = video.dataset.src + "#t=0.1";
}

function detachMedia(video) {
    if (video.dataset.loaded !== "1") return;
    if (video === _previewVideo) stopPreview();
    video.dataset.loaded = "0";
    video.parentNode?.classList.remove("is-loading");
    video.pause();
    video.classList.remove("is-ready");
    video.removeAttribute("src");
    video.load(); // освобождает буфер декодера
}

/** Отпускает плитку: снимает видео с наблюдения и убирает узел из дерева. */
function releaseTile(tile) {
    const video = tile.querySelector("video");
    if (video) {
        detachMedia(video);
        mediaObserver.unobserve(video);
    }
    tile.remove();
}

/** Сносит все плитки и отпускает связанные с ними видео. */
function clearTiles() {
    stopPreview();
    // Плитку могли снести, пока курсор был на ней — mouseleave тогда не придёт
    list.classList.remove("is-focusing");
    for (const tile of _tiles) releaseTile(tile);
    _tiles = [];
    _first = 0;
    list.innerHTML = ""; // распорки и заглушка «ничего не найдено»
}

// ─── Окно отрисовки ───────────────────────────────────────────────────────
//
// В дереве держим только плитки рядом с видимой областью, а место остальных
// занимают две распорки — над окном и под ним. Полоса прокрутки при этом
// честная: распорка ровно той высоты, которую заняли бы убранные ряды.
//
// Зачем так. Раньше плитки накапливались по мере прокрутки и не убирались
// никогда: пролистав плейлист на восемь тысяч, столько же узлов, столько же
// <video> и столько же целей IntersectionObserver и получаешь. Браузер тратил
// на них время в каждом кадре, даже когда на экране ничего не менялось, —
// отсюда и рывки на глубине списка. Теперь узлов всегда примерно поровну,
// и прокрутка на восьмитысячном ролике стоит столько же, сколько на первом.
//
// Считать позиции можно, не отрисовывая ряды: все плитки одной высоты (кадр
// квадратный, подпись лежит поверх него, а не под ним), поэтому ряд номер N
// начинается на известном расстоянии от верха.

const OVERSCAN_ROWS = 3; // рядов сверх экрана в каждую сторону
const FIRST_FILL = 24;   // плиток до первого замера: мерить нужно по живой

const topSpacer = document.createElement("div");
topSpacer.className = "coub-grid-spacer";
const bottomSpacer = document.createElement("div");
bottomSpacer.className = "coub-grid-spacer";

let _tiles = [];        // отрисованные плитки по порядку
let _first = 0;         // позиция _tiles[0] в _filtered
let _cols = 1;
let _rowH = 0;          // высота ряда вместе с зазором
let _gap = 0;
let _padTop = 0;
let _entering = false;  // первая заливка — показываем волну появления
let _growOnly = false;  // во время перетаскивания плитки только добавляем
let _scrollPending = false;

function rowsTotal() {
    return Math.ceil(_filtered.length / _cols);
}

/** Снимает шаг сетки с живых плиток. Требует хотя бы одной отрисованной. */
function measure() {
    const style = getComputedStyle(list);
    _cols = Math.max(1, style.gridTemplateColumns.split(" ").filter(Boolean).length);
    _gap = parseFloat(style.rowGap) || 0;
    _padTop = parseFloat(style.paddingTop) || 0;

    // Именно offsetHeight: плитка бывает увеличена (:hover) или уменьшена
    // (волна появления), а нам нужен её размер в раскладке — тот, по которому
    // сетка считает ряды. getBoundingClientRect вернул бы размер вместе
    // с этими преобразованиями и промахнулся бы на десятки процентов.
    const h = _tiles[0] ? _tiles[0].offsetHeight : 0;
    _rowH = h > 0 ? h + _gap : 0;
}

/** Какие плитки должны быть в дереве при текущей прокрутке. */
function desiredWindow() {
    const total = _filtered.length;
    if (!_rowH || !total) return { first: _first, count: Math.min(total, FIRST_FILL) };

    const viewTop = list.scrollTop - _padTop;
    const firstRow = Math.max(0, Math.floor(viewTop / _rowH) - OVERSCAN_ROWS);
    const lastRow = Math.min(
        rowsTotal() - 1,
        Math.floor((viewTop + list.clientHeight) / _rowH) + OVERSCAN_ROWS
    );

    const first = Math.min(firstRow * _cols, Math.max(0, total - 1));
    const end = Math.min(total, (lastRow + 1) * _cols);
    return { first, count: Math.max(1, end - first) };
}

function updateWindow() {
    if (!_filtered.length) return;
    if (!_rowH && _tiles.length) measure();
    const { first, count } = desiredWindow();
    setWindow(first, count);
}

/**
 * Приводит дерево к окну [first, first + count).
 *
 * Окно всегда начинается с начала ряда: распорка занимает всю ширину сетки,
 * и неполный ряд сразу после неё разъехался бы не по своим колонкам.
 */
function setWindow(first, count) {
    const total = _filtered.length;
    if (!total) return;

    first = Math.max(0, Math.min(first, total - 1));
    count = Math.max(1, Math.min(count, total - first));

    // Перетаскиваемая плитка не должна исчезнуть из-под курсора вместе со
    // своим drag-сеансом, поэтому пока тащат — только прибавляем
    if (_growOnly && _tiles.length) {
        const end = Math.max(_first + _tiles.length, first + count);
        first = Math.min(_first, first);
        count = end - first;
    }

    const oldFirst = _first;
    const oldEnd = _first + _tiles.length;
    const newEnd = first + count;
    if (first === oldFirst && newEnd === oldEnd) return;

    // Окна не пересеклись (прыжок к ролику, скачок полосой прокрутки) —
    // дешевле собрать заново, чем сшивать по краям
    if (!_tiles.length || first >= oldEnd || newEnd <= oldFirst) {
        for (const tile of _tiles) releaseTile(tile);
        _tiles = [];
        _first = first;
        appendTiles(first, count);
    } else {
        if (first > oldFirst) removeFront(first - oldFirst);
        if (newEnd < oldEnd) removeBack(oldEnd - newEnd);
        if (first < oldFirst) prependTiles(first, oldFirst - first);
        if (newEnd > oldEnd) appendTiles(oldEnd, newEnd - oldEnd);
    }

    updateSpacers();
}

function buildRange(start, n) {
    const frag = document.createDocumentFragment();
    const fresh = [];
    for (let i = 0; i < n; i++) {
        const entry = _filtered[start + i];
        if (!entry) break;
        const tile = buildTile(entry, start + i);
        fresh.push(tile);
        frag.appendChild(tile);
    }
    return { frag, fresh };
}

function appendTiles(start, n) {
    const { frag, fresh } = buildRange(start, n);
    list.insertBefore(frag, bottomSpacer);
    _tiles.push(...fresh);
    if (_entering) playEntrance(fresh);
}

function prependTiles(start, n) {
    const { frag, fresh } = buildRange(start, n);
    list.insertBefore(frag, _tiles[0] || bottomSpacer);
    _tiles.unshift(...fresh);
    _first = start;
}

function removeFront(n) {
    _tiles.splice(0, n).forEach(releaseTile);
    _first += n;
}

function removeBack(n) {
    _tiles.splice(Math.max(0, _tiles.length - n), n).forEach(releaseTile);
}

function updateSpacers() {
    setSpacer(topSpacer, Math.floor(_first / _cols));
    setSpacer(bottomSpacer, rowsTotal() - Math.ceil((_first + _tiles.length) / _cols));
}

function setSpacer(el, rows) {
    // Ноль рядов — это не нулевая высота, а отсутствие: распорка остаётся
    // элементом сетки и добавила бы лишний зазор
    if (rows <= 0 || !_rowH) {
        el.style.display = "none";
        return;
    }
    el.style.display = "";
    el.style.height = (rows * _rowH - _gap) + "px";
}

/**
 * Волна появления: класс снимается с плиток по очереди, дальше их доводит
 * переход в CSS. Через setTimeout, а не requestAnimationFrame — кадры идут
 * не всегда (свёрнутое окно, фоновая вкладка), а плитка обязана стать видимой
 * в любом случае.
 *
 * Задержка растёт только у первых полутора десятков: дальше они всё равно за
 * краем экрана, а ждать своей очереди пришлось бы секунды.
 */
function playEntrance(tiles) {
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        tile.classList.add("coub-tile--enter");
        setTimeout(() => tile.classList.remove("coub-tile--enter"), Math.min(i, 14) * 30);
    }
}

/**
 * Пересчитать шаг сетки и окно. Нужно после всего, что меняет размер плиток
 * или ширину списка: окно панели, размер плитки S/M/L.
 *
 * Верх видимой области удерживаем на том же ролике: иначе смена размера
 * уносила бы пользователя в случайное место списка.
 */
function relayout() {
    if (!isGridMode() || !_tiles.length) return;

    const anchorRow = _rowH ? Math.floor(Math.max(0, list.scrollTop - _padTop) / _rowH) : 0;
    const anchorPos = anchorRow * _cols;

    measure();

    if (_rowH) {
        updateSpacers();
        list.scrollTop = _padTop + Math.floor(anchorPos / _cols) * _rowH;
    }
    updateWindow();
}

/** Прокрутить к позиции в _filtered, поставив её в середину экрана. */
function scrollToPos(pos) {
    if (!_rowH) measure();
    if (!_rowH) return;
    const row = Math.floor(pos / _cols);
    const target = _padTop + row * _rowH - Math.max(0, (list.clientHeight - _rowH) / 2);
    list.scrollTop = Math.max(0, target);
    updateWindow();
}

// ─── Init ─────────────────────────────────────────────────────────────────

export function initGridView({
    getItems, getCurrentIndex, getPlaylistName, onPick,
    getTileSize, onTileSizeChange,
    getViewMode, onViewModeChange,
    getVolume, onPreviewActive,
    getPlaylists, onCreatePlaylist, onBulkAddToPlaylist,
    getAllTags, onBulkAddTag,
    getPresets, onBulkApplyPreset,
    getReorderInfo, onReorder,
    onPlayerActive, onBgPreview,
}) {
    _getItems = getItems;
    _getCurrentIndex = getCurrentIndex;
    _getPlaylistName = getPlaylistName;
    _onPick = onPick;
    _onTileSizeChange = onTileSizeChange;
    _onViewModeChange = onViewModeChange;
    _getVolume = getVolume || _getVolume;
    _onPreviewActive = onPreviewActive;
    _getPlaylists = getPlaylists || _getPlaylists;
    _onCreatePlaylist = onCreatePlaylist;
    _onBulkAddToPlaylist = onBulkAddToPlaylist;
    _getAllTags = getAllTags || _getAllTags;
    _onBulkAddTag = onBulkAddTag;
    _getPresets = getPresets || _getPresets;
    _onBulkApplyPreset = onBulkApplyPreset;
    _getReorderInfo = getReorderInfo || _getReorderInfo;
    _onReorder = onReorder;
    _onPlayerActive = onPlayerActive;
    _onBgPreview = onBgPreview;

    setTileSize(getTileSize?.() || "m");

    viewModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-view]");
        if (!btn) return;
        setViewMode(btn.dataset.view);
        btn.blur();
    });

    sizeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-size]");
        if (!btn) return;
        setTileSize(btn.dataset.size);
        _onTileSizeChange?.(btn.dataset.size);
    });

    search.addEventListener("input", () => {
        const q = search.value.trim();
        searchClear.classList.toggle("hidden", !q);
        applyFilter(q);
    });

    // Enter не ждёт паузы: человек уже дописал и хочет результат сейчас
    search.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !_semantic) return;
        e.preventDefault();
        const q = search.value.trim();
        clearTimeout(_semanticTimer);
        if (q) runSemanticSearch(q);
    });

    semanticBtn?.addEventListener("click", () => {
        setSemanticMode(!_semantic);
        search.focus();
    });

    searchClear.addEventListener("click", () => {
        search.value = "";
        searchClear.classList.add("hidden");
        search.focus();
        applyFilter("");
    });

    initBulkActions();
    initDragAndDrop();

    // Заранее: к моменту, когда сетку откроют, список готовых кадров
    // должен быть на руках — иначе первая отрисовка возьмёт видео
    primeThumbs();
    primeChannels();

    // Прокрутка двигает окно отрисовки. Не чаще кадра: событий приходит
    // намного больше, а смысл пересчёта появляется только перед отрисовкой
    list.addEventListener("scroll", () => {
        if (_scrollPending) return;
        _scrollPending = true;
        requestAnimationFrame(() => {
            _scrollPending = false;
            updateWindow();
        });
    }, { passive: true });

    // Ширина списка решает, сколько колонок в ряду, а от этого зависит всё
    // остальное — и высота распорок, и то, какие плитки сейчас видны
    new ResizeObserver(() => relayout()).observe(list);

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) {
            // Из поля поиска сетки Escape должен выпускать наружу
            if (e.key === "Escape" && e.target === search) {
                e.preventDefault();
                search.blur();
            }
            return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        if (e.key === "Escape" && isGridMode()) {
            // Панель «Безумие» закрывает себя сама — не отбираем у неё Escape
            if (isMadnessPanelOpen()) return;
            // Сворачиваем по одному уровню: выпадашка → выделение → вид
            e.preventDefault();
            if (!popover.classList.contains("hidden")) closeBulkPopover();
            else if (_selected.size) clearSelection();
            else setViewMode("list");
            return;
        }

        // code — на случай кириллической раскладки, key — на случай эмуляции
        // клавиатуры без code (некоторые автоматизации)
        if (e.code === "KeyG" || e.key === "g" || e.key === "G") {
            e.preventDefault();
            setViewMode(isGridMode() ? "list" : "grid");
        }
    });

    // Клик мимо выпадашки закрывает её. Кнопки самой панели массовых действий
    // из этого исключены: менять выделение, не закрывая уже открытый список, —
    // нормальный сценарий.
    document.addEventListener("click", (e) => {
        if (popover.classList.contains("hidden")) return;
        if (popover.contains(e.target) || e.target.closest(".grid-bulk-bar")) return;
        closeBulkPopover();
    }, true);

    setViewMode(getViewMode?.() || "list", { silent: true });
}

// ─── Переключение вида ────────────────────────────────────────────────────

export function isGridMode() {
    return _viewMode === "grid";
}

/**
 * Переставляет ползунок громкости между нижней панелью и строкой сетки.
 *
 * Именно переставляет, а не заводит второй: два ползунка пришлось бы
 * синхронизировать, и они бы однажды разошлись. Обработчики висят на самом
 * элементе и переезд переживают.
 *
 * Исходное место запоминаем соседом, а не родителем: в панели ползунок не
 * первый, и возвращать его надо туда же, откуда взяли.
 */
let _volumeHome = null;

function moveVolumeControl(toGrid) {
    const slider = document.getElementById("volumeSlider");
    const slot = document.getElementById("gridVolumeSlot");
    if (!slider || !slot) return;

    if (!_volumeHome) {
        _volumeHome = { parent: slider.parentNode, before: slider.nextSibling };
    }

    if (toGrid) {
        if (slider.parentNode !== slot) slot.appendChild(slider);
    } else if (slider.parentNode === slot) {
        _volumeHome.parent.insertBefore(slider, _volumeHome.before);
    }
}

export function setViewMode(mode, { silent = false } = {}) {
    const next = mode === "grid" ? "grid" : "list";
    const changed = next !== _viewMode;
    _viewMode = next;

    document.body.classList.toggle("view-grid", isGridMode());
    [...viewModeGroup.children].forEach((b) =>
        b.classList.toggle("active", b.dataset.view === _viewMode)
    );

    moveVolumeControl(isGridMode());

    if (isGridMode()) {
        // Режим «плитка» полностью выключает плеер: звучать и крутиться
        // должна только плитка под курсором
        _onPlayerActive?.(false);
        rebuild();

        // Список готовых кадров обычно уже загружен — его берёт и панель
        // плейлистов. Если сетку открыли первой, пересобираем, когда он
        // придёт: до этого плитки взяли видео, как было раньше
        if (!thumbsReady()) {
            primeThumbs().then(() => { if (isGridMode()) rebuild(); });
        }
    } else {
        closeBulkPopover();
        clearSelection();
        clearTiles();
        _onPlayerActive?.(true);
    }

    if (changed && !silent) _onViewModeChange?.(_viewMode);
}

/**
 * Пересобрать сетку из текущего плейлиста плеера.
 * Вызывается при смене плейлиста, сортировки и тег-фильтра.
 */
export function refreshGrid() {
    if (!isGridMode()) return;
    rebuild();
}

function rebuild() {
    _entries = (_getItems() || []).map((item, index) => ({ item, index }));
    _entryById = new Map(_entries.map((e) => [e.item.key, e]));

    // Выделение переживает пересборку только для тех роликов, что остались
    for (const id of [..._selected]) if (!_entryById.has(id)) _selected.delete(id);

    const info = _getReorderInfo();
    _reorderEnabled = !!info.enabled;
    list.classList.toggle("coub-grid--reorderable", _reorderEnabled);

    applyFilter(search.value.trim());
    updateBulkBar();
    requestAnimationFrame(scrollActiveIntoView);
}

/** Подсветить плитку текущего ролика (плеер мог переключиться и в фоне). */
export function syncGridToVideo() {
    if (!isGridMode()) return;
    const current = _getCurrentIndex();
    list.querySelectorAll(".coub-tile").forEach((tile) => {
        tile.classList.toggle("coub-tile--active", Number(tile.dataset.index) === current);
    });
}

// ─── Размер плиток ────────────────────────────────────────────────────────

function setTileSize(size) {
    _tileSize = TILE_MIN_PX[size] ? size : "m";
    list.style.setProperty("--coub-tile-min", TILE_MIN_PX[_tileSize] + "px");
    [...sizeGroup.children].forEach((b) =>
        b.classList.toggle("active", b.dataset.size === _tileSize)
    );
    // Размер плитки — это и шаг сетки, и число колонок, и поля списка.
    // Ширина самого списка при этом не меняется, так что ResizeObserver
    // молчит и пересчитать окно надо самим
    relayout();
}

// ─── Рендер ───────────────────────────────────────────────────────────────

function applyFilter(query) {
    const q = query.trim();

    // Смысловой поиск уходит в модель и на сервер, то есть не мгновенен.
    // Пока ответ не пришёл, на экране остаётся прежнее — это честнее, чем
    // мигать пустым списком на каждую букву
    if (_semantic && q) {
        clearTimeout(_semanticTimer);
        _semanticTimer = setTimeout(() => runSemanticSearch(q), SEMANTIC_DEBOUNCE_MS);
        if (!_semanticBusy) setCaption("Ищу по смыслу…");
        return;
    }

    _semanticGen++; // отменяем ответ на запрос, который уже не нужен

    // Название, автор и id одной строкой: искать приходится по всем трём,
    // а держать их врозь значило бы искать трижды
    _filtered = q
        ? filterByQuery(_entries, q, ({ item }) =>
            `${item.title || ""} ${channelOf(coubIdFromKey(item.key))} ${item.id || ""}`)
        : _entries;

    updateCaption(!!q);
    renderFiltered();
}

/** Рисует сетку по уже отобранному _filtered. */
function renderFiltered() {
    _anchorPos = null;
    clearTiles();

    if (!_filtered.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = _entries.length
            ? "Ничего не найдено"
            : "В плейлисте нет видео";
        list.appendChild(empty);
        return;
    }

    list.appendChild(topSpacer);
    list.appendChild(bottomSpacer);
    setSpacer(topSpacer, 0);
    setSpacer(bottomSpacer, 0);
    list.scrollTop = 0;

    // Первую горсть рисуем вслепую: шаг сетки снимается с живой плитки,
    // а до первой отрисовки мерить нечего. Дальше окно само дотянется
    // до нужного размера — экран мог оказаться и выше этой горсти.
    _rowH = 0;
    _entering = true;
    appendTiles(0, Math.min(_filtered.length, FIRST_FILL));
    measure();
    updateWindow();
    _entering = false;
}

function updateCaption(isSearch) {
    const name = _getPlaylistName() || "—";
    const base = isSearch
        ? `${name} · найдено ${_filtered.length} из ${_entries.length}`
        : `${name} · ${_entries.length} видео`;

    const info = _getReorderInfo();
    subtitle.textContent = info.enabled || !info.hint ? base : `${base} · ${info.hint}`;
    subtitle.title = subtitle.textContent;
}

function buildTile({ item, index }, pos) {
    const tile = document.createElement("div");
    tile.className = "coub-tile";
    tile.dataset.index = index;
    tile.dataset.pos = pos;
    tile.dataset.id = item.key;
    tile.draggable = _reorderEnabled;
    if (index === _getCurrentIndex()) tile.classList.add("coub-tile--active");
    if (_selected.has(item.key)) tile.classList.add("coub-tile--selected");

    const media = document.createElement("div");
    media.className = "coub-tile-media";

    // Кадр ключуется id самого ролика, а не записью плейлиста: у дубликата
    // ключ свой ("4aqice#2"), а кадр тот же самый
    const coubId = coubIdFromKey(item.key);
    const still = hasThumb(coubId) ? document.createElement("img") : null;
    if (still) {
        still.className = "coub-tile-still";
        still.src = thumbUrl(coubId);
        still.alt = "";
        still.draggable = false;
        still.decoding = "async";
    }

    const video = document.createElement("video");
    video.muted = true; // звук идёт отдельной дорожкой через previewAudio
    video.loop = true;
    video.playsInline = true;
    video.draggable = false; // тащим плитку целиком, а не видео внутри неё
    // metadata (а не none) — иначе браузер не дойдёт до кадра #t=0.1 и плитка
    // останется пустой до наведения курсора
    video.preload = "metadata";
    video.dataset.src = item.video || "";
    if (still) video.dataset.still = "1";
    video.addEventListener("loadeddata", () => {
        video.classList.add("is-ready");
        media.classList.remove("is-loading");
        // Кадра для этого ролика ещё нет — снимаем, раз уж видео всё равно
        // загружено. В следующий раз плитка обойдётся картинкой
        if (!still) captureThumb(video, coubId);
    });

    // Персональная постобработка ролика видна и в превью. Случайные настройки
    // «Безумия» сюда не тянем — это перемешивание для просмотра списком.
    if (item.fx) {
        const fx = composeSettings(item.fx);
        if (fx.filter) video.style.filter = fx.filter;
        if (fx.transform) video.style.transform = fx.transform;
        // Картинка в покое должна выглядеть как видео под курсором, иначе
        // обработанный ролик «перекрашивался» бы при наведении
        if (still) {
            if (fx.filter) still.style.filter = fx.filter;
            if (fx.transform) still.style.transform = fx.transform;
        }
        // defaultPlaybackRate — чтобы скорость пережила ленивую загрузку src
        video.defaultPlaybackRate = fx.speed;
        video.playbackRate = fx.speed;
    }

    const check = document.createElement("div");
    check.className = "coub-tile-check";
    check.title = "Выделить";

    // «Похожие на этот» — вектор кадра уже лежит в базе, считать нечего,
    // поэтому кнопка работает и без скачанной текстовой башни
    const similar = document.createElement("button");
    similar.type = "button";
    similar.className = "coub-tile-similar";
    similar.title = "Показать похожие на этот";
    similar.innerHTML = `
        <svg viewBox="0 0 16 16" aria-hidden="true" width="11" height="11">
            <circle cx="6" cy="6" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="10.4" cy="10.4" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
        </svg>`;

    const indexBadge = document.createElement("span");
    indexBadge.className = "coub-tile-index";
    indexBadge.textContent = index + 1;

    const nowBadge = document.createElement("span");
    nowBadge.className = "coub-tile-now";
    nowBadge.textContent = "Сейчас";

    // Картинка под видео: пока видео не готово (а в покое его и нет вовсе),
    // видно её, а появившееся видео проявляется поверх
    if (still) media.appendChild(still);
    media.appendChild(video);
    media.appendChild(check);
    media.appendChild(similar);
    media.appendChild(indexBadge);
    media.appendChild(nowBadge);

    const title = document.createElement("div");
    title.className = "coub-tile-title";
    title.textContent = item.title || item.id;

    // Подсказка висит на плитке, а не на подписи: у подписи отключены
    // события мыши, и её собственный title не показался бы никогда.
    //
    // Автор здесь потому, что по нему ищут, а увидеть его было негде:
    // найдя десяток роликов по каналу, оставалось верить на слово
    const автор = channelOf(coubId);
    tile.title = автор
        ? `${item.title || item.id}\n${автор}`
        : (item.title || item.id);

    tile.appendChild(media);
    tile.appendChild(title);

    tile.addEventListener("mouseenter", () => {
        // У плитки с картинкой видео до сих пор не грузилось — заводим его
        // здесь. Порядок важен: startPreview зовёт play() только у того,
        // что уже подключено.
        //
        // Зовём и для плиток без картинки: обычно их видео уже подключил
        // наблюдатель, но если оно ещё не дошло, наведение не должно
        // упираться в пустой прямоугольник. Повторный вызов ничего не делает
        attachMedia(video);
        startPreview(video, item);
        setFocusing(true);
    });
    tile.addEventListener("mouseleave", () => {
        if (_previewVideo === video) stopPreview();
        // Живым остаётся только видео под курсором: у остальных плиток кадр
        // показывает картинка, декодер им не нужен
        if (still) detachMedia(video);
        setFocusing(false);
    });

    check.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelection(item.key, Number(tile.dataset.pos), tile);
    });

    similar.addEventListener("click", (e) => {
        e.stopPropagation();
        showSimilar(coubId, item.title || item.id);
    });

    tile.addEventListener("click", (e) => {
        e.stopPropagation();

        if (e.shiftKey && _anchorPos !== null) {
            selectRange(_anchorPos, Number(tile.dataset.pos));
            return;
        }
        if (e.ctrlKey || e.metaKey || _selected.size) {
            toggleSelection(item.key, Number(tile.dataset.pos), tile);
            return;
        }
        jumpTo(Number(tile.dataset.index));
    });

    // Пока идёт выделение, обычный клик переключает чекбокс —
    // перейти к ролику можно двойным кликом
    tile.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (!_selected.size) return;
        jumpTo(Number(tile.dataset.index));
    });

    // Наблюдаем только за плитками без картинки: им видео нужно, чтобы
    // вообще что-то показать (и чтобы снять с него кадр на будущее).
    // Остальные заводят видео при наведении и сразу отпускают
    if (!still) mediaObserver.observe(video);
    return tile;
}

function jumpTo(index) {
    setViewMode("list");
    _onPick?.(index);
}

function scrollActiveIntoView() {
    const current = _getCurrentIndex();
    if (current < 0) return;

    // Плитки текущего ролика может не быть в дереве — прокручиваем не к ней,
    // а к её месту: ряд считается по номеру позиции, окно подтянется следом
    const pos = _filtered.findIndex((e) => e.index === current);
    if (pos === -1) return;
    scrollToPos(pos);
}

// ─── Перетаскивание (изменение порядка) ───────────────────────────────────

function initDragAndDrop() {
    list.addEventListener("dragstart", (e) => {
        const tile = e.target.closest(".coub-tile");
        if (!tile || !_reorderEnabled) return;

        _dragTile = tile;
        // Пока тащат, окно только прибавляет плитки: убрать перетаскиваемую
        // из дерева — значит оборвать сам drag-сеанс
        _growOnly = true;
        stopPreview();
        e.dataTransfer.effectAllowed = "move";
        // Без setData Firefox не начинает перетаскивание вовсе
        e.dataTransfer.setData("text/plain", tile.dataset.id);
        list.classList.add("coub-grid--dragging");
        requestAnimationFrame(() => tile.classList.add("coub-tile--dragging"));
    });

    list.addEventListener("dragover", (e) => {
        if (!_dragTile) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        autoScroll(e.clientY);

        const target = e.target.closest(".coub-tile");
        if (!target || target === _dragTile) return;

        // Плитки лежат сеткой, поэтому сторону определяем по горизонтали:
        // курсор в левой половине — встать перед плиткой, в правой — после
        const rect = target.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        list.insertBefore(_dragTile, after ? target.nextSibling : target);
    });

    list.addEventListener("drop", (e) => {
        if (_dragTile) e.preventDefault();
    });

    list.addEventListener("dragend", () => {
        if (!_dragTile) return;
        _dragTile.classList.remove("coub-tile--dragging");
        list.classList.remove("coub-grid--dragging");
        _dragTile = null;
        commitReorder();
        _growOnly = false;
        updateWindow(); // отпускаем всё, что наросло за время перетаскивания
    });
}

function autoScroll(clientY) {
    const rect = list.getBoundingClientRect();
    if (clientY < rect.top + DRAG_SCROLL_ZONE) list.scrollTop -= 18;
    else if (clientY > rect.bottom - DRAG_SCROLL_ZONE) list.scrollTop += 18;
}

/**
 * Считывает новый порядок из DOM и раскладывает его обратно в модель.
 *
 * Отрисован кусок _filtered от _first длиной в окно, а сам _filtered может
 * быть подмножеством _entries (включён поиск). Поэтому:
 *   • новый _filtered = хвосты по обе стороны окна как были + порядок плиток
 *     в DOM между ними;
 *   • в _entries переставленные ролики раскладываются по тем же позициям,
 *     которые занимали до этого — ровно так же, как это делает сервер
 *     (см. Reorder в PlaylistsController).
 */
function commitReorder() {
    const domTiles = [...list.querySelectorAll(".coub-tile")];
    const renderedEntries = domTiles
        .map((t) => _entryById.get(t.dataset.id))
        .filter(Boolean);

    if (renderedEntries.length !== _tiles.length) return; // рассинхрон — не рискуем

    // Перетаскивание переставило узлы мимо нас — приводим окно к дереву
    _tiles = domTiles;

    const newFiltered = [
        ..._filtered.slice(0, _first),
        ...renderedEntries,
        ..._filtered.slice(_first + renderedEntries.length),
    ];
    const unchanged = newFiltered.every((e, i) => e === _filtered[i]);
    if (unchanged) return;

    const filteredKeys = new Set(_filtered.map((e) => e.item.key));
    const slots = [];
    _entries.forEach((e, i) => { if (filteredKeys.has(e.item.key)) slots.push(i); });

    const newEntries = [..._entries];
    slots.forEach((slot, k) => { newEntries[slot] = newFiltered[k]; });

    _entries = newEntries;
    _filtered = newFiltered;
    _entries.forEach((e, i) => { e.index = i; });

    // Плитки уже стоят в нужном порядке — обновляем только подписи и датасеты
    domTiles.forEach((tile, pos) => {
        const entry = _entryById.get(tile.dataset.id);
        if (!entry) return;
        tile.dataset.index = entry.index;
        tile.dataset.pos = _first + pos; // позиция в списке, а не в окне
        tile.querySelector(".coub-tile-index").textContent = entry.index + 1;
        tile.classList.toggle("coub-tile--active", entry.index === _getCurrentIndex());
    });
    _anchorPos = null;

    _onReorder?.({
        orderedItems: _entries.map((e) => e.item),
        visibleIds: _filtered.map((e) => e.item.key),
    });
}

// ─── Выделение ────────────────────────────────────────────────────────────

function toggleSelection(id, pos, tile) {
    if (_selected.has(id)) _selected.delete(id);
    else _selected.add(id);

    tile.classList.toggle("coub-tile--selected", _selected.has(id));
    _anchorPos = pos;
    updateBulkBar();
}

function selectRange(fromPos, toPos) {
    const [a, b] = fromPos <= toPos ? [fromPos, toPos] : [toPos, fromPos];
    for (let p = a; p <= b; p++) {
        const entry = _filtered[p];
        if (entry) _selected.add(entry.item.key);
    }
    _anchorPos = toPos;
    syncSelectionClasses();
    updateBulkBar();
}

function clearSelection() {
    _selected.clear();
    _anchorPos = null;
    syncSelectionClasses();
    updateBulkBar();
}

function syncSelectionClasses() {
    list.querySelectorAll(".coub-tile").forEach((tile) => {
        tile.classList.toggle("coub-tile--selected", _selected.has(tile.dataset.id));
    });
}

function updateBulkBar() {
    const n = _selected.size;
    bulkBar.hidden = n === 0;
    list.classList.toggle("coub-grid--selecting", n > 0);
    if (n) bulkCount.textContent = `Выбрано: ${n}`;
    if (!n) closeBulkPopover();
    else if (_bulkMode) updatePopoverTitle();
}

/** Выделенные ролики в порядке текущего списка (а не порядке кликов). */
function selectedItems() {
    return _entries
        .filter(({ item }) => _selected.has(item.key))
        .map(({ item }) => item);
}

// ─── Массовые действия ────────────────────────────────────────────────────

function initBulkActions() {
    bulkAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        for (const entry of _filtered) _selected.add(entry.item.key);
        syncSelectionClasses();
        updateBulkBar();
    });

    bulkClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSelection();
    });

    bulkPlaylistBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBulkPopover(_bulkMode === "playlist" ? null : "playlist");
    });

    bulkTagBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBulkPopover(_bulkMode === "tag" ? null : "tag");
    });

    bulkPresetBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBulkPopover(_bulkMode === "preset" ? null : "preset");
    });

    popoverClose.addEventListener("click", closeBulkPopover);

    popoverInput.addEventListener("input", () => renderPopoverList(popoverInput.value.trim()));
    popoverInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            commitPopoverInput();
        }
    });
    popoverAddBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        commitPopoverInput();
    });
}

function openBulkPopover(mode) {
    if (!mode) {
        closeBulkPopover();
        return;
    }
    _bulkMode = mode;
    const isTag = mode === "tag";

    updatePopoverTitle();
    popoverInput.placeholder = isTag
        ? "Новый или существующий тег…"
        : mode === "preset" ? "Найти пресет…" : "Найти плейлист…";
    popoverInput.maxLength = isTag ? 40 : 80;
    popoverAddBtn.classList.toggle("hidden", !isTag);
    popoverInput.value = "";

    renderPopoverList("");
    popover.classList.remove("hidden");
    requestAnimationFrame(() => popoverInput.focus());
}

function updatePopoverTitle() {
    const label = _bulkMode === "tag" ? "Добавить тег"
        : _bulkMode === "preset" ? "Применить пресет"
            : "В плейлист";
    popoverTitle.textContent = `${label} · ${_selected.size}`;
}

function closeBulkPopover() {
    popover.classList.add("hidden");
    _bulkMode = null;
}

function renderPopoverList(query) {
    const q = query.trim();
    popoverList.innerHTML = "";

    let rows;
    if (_bulkMode === "tag") {
        rows = filterByQuery(_getAllTags(), q, ({ tag }) => tag)
            .map(({ tag, count }) => ({ name: tag, note: `${count} видео` }));
    } else if (_bulkMode === "preset") {
        rows = filterByQuery(_getPresets() || [], q, (p) => p.name)
            .map((p) => ({
                name: p.name,
                note: p.bgSeparate
                    ? `${Object.keys(p.fx || {}).length} + фон`
                    : `${Object.keys(p.fx || {}).length} настроек`,
                preset: p,
            }));
    } else {
        const all = Object.entries(_getPlaylists())
            .filter(([name]) => !BULK_EXCLUDED_PLAYLISTS.includes(name));
        rows = filterByQuery(all, q, ([name]) => name)
            .map(([name, data]) => ({
                name,
                note: `${Object.keys(data.videos || {}).length} видео`,
            }));
    }

    for (const row of rows) popoverList.appendChild(buildPopoverRow(row));

    if (_bulkMode === "playlist") {
        popoverList.appendChild(buildCreatePlaylistRow());
    } else if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = _bulkMode === "preset"
            ? "Пресетов пока нет — сохраните первый во вкладке «Эффекты»"
            : q ? "Нажмите ＋ чтобы создать тег" : "Тегов пока нет";
        popoverList.appendChild(empty);
    }
}

function buildPopoverRow({ name, note, preset }) {
    const row = document.createElement("div");
    row.className = "pl-row";

    const text = document.createElement("div");
    text.className = "pl-row-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-row-name";
    nameEl.textContent = name;

    const noteEl = document.createElement("div");
    noteEl.className = "pl-row-count";
    noteEl.textContent = note;

    text.appendChild(nameEl);
    text.appendChild(noteEl);
    row.appendChild(text);

    row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (_bulkMode === "tag") runBulkTag(name);
        else if (_bulkMode === "preset") runBulkPreset(preset);
        else runBulkPlaylist(name);
    });

    return row;
}

function buildCreatePlaylistRow() {
    const row = document.createElement("div");
    row.className = "pl-row";

    const text = document.createElement("div");
    text.className = "pl-row-text";
    const nameEl = document.createElement("div");
    nameEl.className = "pl-row-name";
    nameEl.textContent = "＋ Создать плейлист";
    text.appendChild(nameEl);
    row.appendChild(text);

    row.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!_onCreatePlaylist) return;
        const name = await _onCreatePlaylist();
        if (name) runBulkPlaylist(name);
    });

    return row;
}

function commitPopoverInput() {
    const value = popoverInput.value.trim();
    if (!value) return;
    if (_bulkMode === "tag") runBulkTag(value);
}

async function runBulkPlaylist(name) {
    if (!_onBulkAddToPlaylist) return;
    await runBulk(
        (items, onProgress) => _onBulkAddToPlaylist(name, items, onProgress),
        (r) => {
            let msg = `<span class="pl-toast-accent">+</span> «${name}»: добавлено ${r.added}`;
            if (r.skipped) msg += `, уже было ${r.skipped}`;
            if (r.failed) msg += `, ошибок ${r.failed}`;
            return msg;
        }
    );
}

async function runBulkTag(tag) {
    if (!_onBulkAddTag) return;
    await runBulk(
        (items, onProgress) => _onBulkAddTag(tag, items, onProgress),
        (r) => {
            let msg = `<span class="pl-toast-accent">#</span> «${tag}»: помечено ${r.added} видео`;
            if (r.failed) msg += `, ошибок ${r.failed}`;
            return msg;
        }
    );
}

async function runBulkPreset(preset) {
    if (!_onBulkApplyPreset || !preset) return;
    await runBulk(
        (items, onProgress) => _onBulkApplyPreset(preset, items, onProgress),
        (r) => {
            let msg = `<span class="pl-toast-accent">✦</span> «${preset.name}»: применён к ${r.applied}`;
            if (r.failed) msg += `, ошибок ${r.failed}`;
            return msg;
        }
    );
}

/**
 * Общая обвязка массовой операции: блокирует панель, показывает прогресс,
 * по завершении сбрасывает выделение и рапортует тостом.
 */
async function runBulk(action, formatToast) {
    if (_bulkBusy) return;
    const items = selectedItems();
    if (!items.length) return;

    _bulkBusy = true;
    setBulkDisabled(true);
    closeBulkPopover();

    try {
        const result = await action(items, (done, total) => {
            bulkCount.textContent = `Обработано ${done}/${total}…`;
        });
        clearSelection();
        showToast(formatToast(result));
    } catch (err) {
        showToast("⚠ Ошибка: " + err.message);
        console.error("Bulk action error:", err);
        updateBulkBar();
    } finally {
        _bulkBusy = false;
        setBulkDisabled(false);
    }
}

function setBulkDisabled(disabled) {
    [bulkAllBtn, bulkClearBtn, bulkPlaylistBtn, bulkTagBtn, bulkPresetBtn].forEach((b) => {
        b.disabled = disabled;
    });
}
