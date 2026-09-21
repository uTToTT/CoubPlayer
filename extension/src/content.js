// content.js
// Живёт на страницах coub.com. Делает две вещи:
//   1. рисует кнопку загрузки на плеере и на карточках ленты;
//   2. служит запасным каналом к API coub.com — со страницы запрос заведомо
//      уходит с куками, даже если из service worker'а они не прикрепились.
//
// Подключается классическим скриптом, поэтому импортов здесь нет:
// имена сообщений продублированы литералами (см. src/messages.js).

(() => {
    "use strict";

    const MSG_COUB_FETCH = "coubFetch";   // см. messages.js
    const MSG_DOWNLOAD_ONE = "downloadOne"; // см. messages.js
    const MSG_PAGE_REQUESTS = "pageRequests"; // см. messages.js
    const MSG_PLAYLISTS = "playlists";        // см. messages.js
    const MSG_CREATE_PLAYLIST = "createPlaylist"; // см. messages.js
    const MSG_LIBRARY = "library";            // см. messages.js
    const MSG_SUGGEST = "suggest";            // см. messages.js

    const DEFAULT_LABEL = "В CoubPlayer";
    const DEFAULT_TITLE = "Скачать в CoubPlayer";

    const BUTTON_CLASS = "cpd-btn";
    const MARK_ATTR = "data-cpd-ready";

    // Кнопки на карточках ленты держатся на селекторе, а разметка coub.com
    // может поменяться в любой день — поэтому их можно выключить из попапа,
    // не трогая плавающую кнопку на странице куба.
    let cardButtonsEnabled = true;

    chrome.storage.local.get("cardButtons").then(({ cardButtons }) => {
        cardButtonsEnabled = cardButtons !== false;
        refresh();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.cardButtons) return;
        cardButtonsEnabled = changes.cardButtons.newValue !== false;
        if (cardButtonsEnabled) refresh();
        else unmountCards();
    });

    // ─── Запасной канал к API ───────────────────────────────────────────────

    // ─── Мост к page-probe.js ───────────────────────────────────────────────
    // Тот скрипт живёт в MAIN world и переменных с нами не делит — только окно.

    function askPageProbe(timeoutMs = 1000) {
        return new Promise((resolve) => {
            const done = (value) => {
                window.removeEventListener("message", onMessage);
                clearTimeout(timer);
                resolve(value);
            };

            const onMessage = (event) => {
                if (event.source !== window) return;
                if (event.data?.source !== "cpd-probe-response") return;
                done(event.data.records || []);
            };

            window.addEventListener("message", onMessage);
            const timer = setTimeout(() => done([]), timeoutMs);
            window.postMessage({ source: "cpd-probe-request" }, location.origin);
        });
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === MSG_PAGE_REQUESTS) {
            askPageProbe().then(sendResponse);
            return true;
        }
        if (message?.type !== MSG_COUB_FETCH) return false;

        fetch(message.url, {
            credentials: "include",
            headers: {
                Accept: "application/json",
                "X-Requested-With": "XMLHttpRequest",
                ...(message.headers || {}),
            },
        })
            .then(async (res) => sendResponse({ status: res.status, body: await res.text() }))
            .catch((err) => sendResponse({ status: 0, body: "", error: String(err) }));

        return true; // ответ придёт асинхронно
    });

    // ─── Что уже скачано ────────────────────────────────────────────────────
    // Отметка на кнопке отвечает на вопрос, ради которого иначе пришлось бы
    // открывать меню или лезть в плеер: это у меня уже есть?
    //
    // Спрашиваем не про всю библиотеку, а только про то, что сейчас на экране,
    // и не чаще, чем появляются новые карточки: лента подгружается кусками,
    // и запрос на каждую был бы десятком запросов в секунду.

    const ASK_DELAY_MS = 250;

    /** permalink → true/false. Ответ на сеанс: скачанное обратно не исчезает. */
    const _known = new Map();

    /** Кнопки, про чьи ролики ещё не спросили. */
    const _pending = new Set();
    let _askTimer = null;

    function markDownloaded(btn) {
        const known = _known.get(btn.dataset.cpdPermalink) === true;
        btn.classList.toggle("is-known", known);

        // На карточке ленты кнопка проявляется только под курсором — а отметка
        // должна быть видна сразу, иначе в ней нет смысла. Поэтому у скачанных
        // гнездо остаётся на виду
        btn.closest(".cpd-card-slot")?.classList.toggle("is-known", known);

        if (known && !btn.classList.contains("is-done")) {
            btn.title = "Уже в CoubPlayer — можно добавить ещё в один плейлист";
        }
    }

    /** Ставит кнопку в очередь на проверку — ответ придёт одним запросом. */
    function askIsDownloaded(btn) {
        const permalink = btn.dataset.cpdPermalink;
        if (!permalink) return;

        if (_known.has(permalink)) {
            // Кнопку в этот момент ещё не вставили в страницу, а отметка ищет
            // гнездо карточки — ставим её, когда вставка уже случилась
            queueMicrotask(() => markDownloaded(btn));
            return;
        }

        _pending.add(btn);
        clearTimeout(_askTimer);
        _askTimer = setTimeout(flushLibraryAsk, ASK_DELAY_MS);
    }

    async function flushLibraryAsk() {
        const batch = [..._pending];
        _pending.clear();
        if (!batch.length) return;

        const ids = [...new Set(batch.map((b) => b.dataset.cpdPermalink).filter(Boolean))];

        try {
            const res = await chrome.runtime.sendMessage({
                type: MSG_LIBRARY,
                payload: { ids },
            });
            if (!res?.ok) return; // плеер не запущен — молчим, это не ошибка страницы

            const have = new Set(res.data.have || []);
            for (const id of ids) _known.set(id, have.has(id));
        } catch {
            // Расширение могло перезагрузиться — отметок просто не будет
            return;
        }

        for (const btn of batch) {
            if (btn.isConnected) markDownloaded(btn);
        }
    }

    /** Ролик скачали прямо сейчас — отметку ставим, не дожидаясь опроса. */
    function rememberDownloaded(permalink) {
        _known.set(permalink, true);
        for (const btn of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
            if (btn.dataset.cpdPermalink === permalink) markDownloaded(btn);
        }
    }

    // ─── Кнопка загрузки ────────────────────────────────────────────────────

    function permalinkFromHref(href) {
        const match = String(href || "").match(/\/view\/([\w-]+)/);
        return match ? match[1] : null;
    }

    /** Permalink куба, на странице которого мы находимся. */
    function currentPermalink() {
        return permalinkFromHref(location.pathname);
    }

    function makeButton(permalink) {
        const btn = document.createElement("button");
        btn.className = BUTTON_CLASS;
        btn.type = "button";
        btn.title = DEFAULT_TITLE;
        btn.dataset.cpdPermalink = permalink;
        btn.innerHTML = `
            <svg viewBox="0 0 20 20" aria-hidden="true" width="15" height="15">
                <path d="M10 3v9m0 0 3.4-3.4M10 12 6.6 8.6" fill="none"
                      stroke="currentColor" stroke-width="1.7"
                      stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M4 14.5v1.2A1.3 1.3 0 0 0 5.3 17h9.4a1.3 1.3 0 0 0 1.3-1.3v-1.2"
                      fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
            </svg>
            <span class="cpd-btn-label">${DEFAULT_LABEL}</span>
            <svg class="cpd-btn-caret" viewBox="0 0 10 6" aria-hidden="true" width="9" height="6">
                <path d="M1 1.4 5 5l4-3.6" fill="none" stroke="currentColor"
                      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`;

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPlaylistMenu(btn);
        });

        askIsDownloaded(btn);
        return btn;
    }

    // Сколько держать «Готово» перед возвратом к обычному виду. Если оставить
    // насовсем, пропадает стрелка — и с ней подсказка, что кнопка открывает
    // список. А добавить тот же ролик во второй плейлист вполне может понадобиться.
    const RESET_AFTER_MS = 2600;

    function setState(btn, state, label) {
        clearTimeout(btn._cpdReset);
        btn.classList.remove("is-busy", "is-done", "is-error");
        if (state) btn.classList.add(state);
        const labelEl = btn.querySelector(".cpd-btn-label");
        if (labelEl && label) labelEl.textContent = label;
    }

    /** Возвращает кнопку в исходный вид, сохраняя подсказку о результате. */
    function scheduleReset(btn) {
        btn._cpdReset = setTimeout(() => {
            setState(btn, null, DEFAULT_LABEL);
            // «Готово» ушло — и на его место возвращается отметка о том,
            // что ролик теперь в библиотеке
            markDownloaded(btn);
        }, RESET_AFTER_MS);
    }

    async function download(btn, playlist) {
        if (btn.classList.contains("is-busy")) return;
        setState(btn, "is-busy", "Качаю…");

        try {
            const res = await chrome.runtime.sendMessage({
                type: MSG_DOWNLOAD_ONE,
                payload: { permalink: btn.dataset.cpdPermalink, playlist },
            });

            if (!res?.ok) throw new Error(res?.error || "Расширение не ответило");

            setState(btn, "is-done", res.data.alreadyExisted ? "Уже есть" : "Готово");
            btn.title = `Плейлист: ${res.data.playlist}`;
            rememberDownloaded(btn.dataset.cpdPermalink);
        } catch (err) {
            setState(btn, "is-error", "Ошибка");
            btn.title = String(err.message || err);
        }
        // Причина видна в подсказке, а сама кнопка возвращается в рабочий вид
        scheduleReset(btn);
    }

    // ─── Меню выбора плейлиста ──────────────────────────────────────────────
    // Меню живёт в body с position: fixed — внутри карточки его обрезало бы
    // overflow'ом, а на странице куба перекрыл бы плеер.

    let openMenu = null;

    function closePlaylistMenu() {
        openMenu?.remove();
        openMenu = null;
    }

    /** Ставит меню рядом с кнопкой, не вылезая за края окна. */
    function placeMenu(menu, btn) {
        const anchor = btn.getBoundingClientRect();
        const box = menu.getBoundingClientRect();
        const gap = 8;

        // Под кнопкой, а если снизу не помещается — над ней
        const below = anchor.bottom + gap;
        const top = below + box.height > window.innerHeight
            ? Math.max(gap, anchor.top - box.height - gap)
            : below;

        const left = Math.min(
            Math.max(gap, anchor.right - box.width),
            window.innerWidth - box.width - gap
        );

        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
    }

    async function openPlaylistMenu(btn) {
        // Меню могло исчезнуть вместе с куском DOM, который перерисовал сайт —
        // тогда ссылка на него висит, а на экране его нет
        if (openMenu && !openMenu.isConnected) openMenu = null;

        if (openMenu?.dataset.for === btn.dataset.cpdPermalink) {
            closePlaylistMenu();
            return;
        }
        closePlaylistMenu();

        const menu = document.createElement("div");
        menu.className = "cpd-menu";
        menu.dataset.for = btn.dataset.cpdPermalink;
        menu.innerHTML = `
            <div class="cpd-menu-tabs" role="tablist">
                <button type="button" class="cpd-menu-tab is-active" data-tab="all">Куда загрузить</button>
                <button type="button" class="cpd-menu-tab" data-tab="similar">Похоже на</button>
            </div>
            <input class="cpd-menu-search" type="text" placeholder="Найти плейлист…"
                   spellcheck="false" autocomplete="off" hidden />
            <div class="cpd-menu-body cpd-menu-loading">Загружаю список…</div>
            <div class="cpd-menu-footer" hidden></div>`;
        document.body.appendChild(menu);
        openMenu = menu;
        placeMenu(menu, btn);

        // Клик по самому меню не должен закрывать его через обработчик ниже
        menu.addEventListener("click", (e) => e.stopPropagation());

        // coub.com слушает клавиши на документе — пробел ставит ролик на паузу,
        // стрелки перематывают. Пока печатают в нашем поле, сайт об этом знать
        // не должен, иначе поиск будет управлять плеером.
        //
        // Escape разбираем здесь же: до общего обработчика на window он из-за
        // этого щита не долетит, а закрывать меню с клавиатуры нужно — это
        // самый естественный жест, когда курсор в поле поиска.
        for (const type of ["keydown", "keyup", "keypress"]) {
            menu.addEventListener(type, (e) => {
                if (type === "keydown" && e.key === "Escape") closePlaylistMenu();
                e.stopPropagation();
            });
        }

        try {
            const res = await chrome.runtime.sendMessage({
                type: MSG_PLAYLISTS,
                payload: { permalink: btn.dataset.cpdPermalink },
            });
            if (!res?.ok) throw new Error(res?.error || "Расширение не ответило");
            if (openMenu !== menu) return; // меню успели закрыть

            setupMenu(menu, btn, res.data);
        } catch (err) {
            if (openMenu !== menu) return;
            menu.querySelector(".cpd-menu-body").textContent = String(err.message || err);
        }

        placeMenu(menu, btn);
    }

    // ─── Группы ─────────────────────────────────────────────────────────────
    // Повторяет раскладку плеера (groupEntries в ui.js): сперва группы в том
    // порядке, в каком их расставили перетаскиванием, затем «Специальные»
    // и остальные по алфавиту, в конце — то, что никуда не отнесли.

    const SPECIAL_GROUP = "Специальные";
    const UNGROUPED_LABEL = "Без группы";
    const SEARCH_FROM = 8; // со скольких плейлистов показывать поиск

    function groupPlaylists(playlists, groupOrder = []) {
        const buckets = new Map();
        for (const pl of playlists) {
            const key = pl.group || "";
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(pl);
        }

        const rank = new Map(groupOrder.map((name, i) => [name, i]));
        const names = [...buckets.keys()].filter(Boolean).sort((a, b) => {
            const ra = rank.has(a) ? rank.get(a) : Infinity;
            const rb = rank.has(b) ? rank.get(b) : Infinity;
            if (ra !== rb) return ra - rb;
            if (a === SPECIAL_GROUP) return -1;
            if (b === SPECIAL_GROUP) return 1;
            return a.localeCompare(b, "ru");
        });
        if (buckets.has("")) names.push("");

        return names.map((name) => ({
            // Единственная группа без имени — значит групп нет вовсе,
            // и подписывать «Без группы» нечего
            name: name || (buckets.size > 1 ? UNGROUPED_LABEL : ""),
            items: buckets.get(name),
        }));
    }

    function setupMenu(menu, btn, data) {
        const search = menu.querySelector(".cpd-menu-search");
        // Подсказки приходят одними именами, а картинки — здесь: вкладке
        // «Похоже на» они нужны те же самые
        menu._cpdPlaylists = new Map(data.playlists.map((pl) => [pl.name, pl]));

        // Поиск относится к полному списку: на вкладке подсказок поле скрыто,
        // и сюда оттуда не приходят
        search.addEventListener("input", () => {
            const query = search.value.trim();
            renderMenuItems(menu, btn, data, query);
            renderFooter(menu, btn, query);
        });

        // Enter забирает первый совпавший — искать и целиться мышью не нужно.
        // Если не совпало ничего, тем же Enter заводится плейлист с этим именем
        search.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            const first = menu.querySelector(".cpd-menu-item");
            if (first) first.click();
            else menu.querySelector(".cpd-menu-create")?.click();
        });

        menu.querySelector(".cpd-menu-tabs").addEventListener("click", (e) => {
            const tab = e.target.closest(".cpd-menu-tab");
            if (!tab || tab.dataset.tab === menu.dataset.tab) return;
            selectTab(menu, btn, tab.dataset.tab, data);
        });

        selectTab(menu, btn, "all", data);
    }

    /**
     * Переключение вкладки. Поиск и строка «Новый плейлист» относятся к полному
     * списку — на вкладке подсказок им делать нечего.
     */
    function selectTab(menu, btn, tab, data) {
        menu.dataset.tab = tab;
        for (const el of menu.querySelectorAll(".cpd-menu-tab")) {
            el.classList.toggle("is-active", el.dataset.tab === tab);
        }

        const search = menu.querySelector(".cpd-menu-search");
        const footer = menu.querySelector(".cpd-menu-footer");

        if (tab === "similar") {
            search.hidden = true;
            footer.hidden = true;
            renderSimilar(menu, btn);
            return;
        }

        search.hidden = data.playlists.length < SEARCH_FROM;
        const query = search.value.trim();
        renderMenuItems(menu, btn, data, query);
        renderFooter(menu, btn, query);
        if (!search.hidden) search.focus();
    }

    // ─── Вкладка «Похоже на» ────────────────────────────────────────────────
    // Те же подсказки, что плеер показывает в панели плейлистов: куда ролик
    // просится по своим тегам. Считает их сервер — здесь только показ.
    //
    // Ответ кэшируем на меню: вкладки переключают туда-сюда, а подсказка для
    // ролика за это время не меняется, и второй поход на coub.com ни к чему.

    async function renderSimilar(menu, btn) {
        const body = menu.querySelector(".cpd-menu-body");

        if (menu._cpdSimilar) {
            paintSimilar(menu, btn, menu._cpdSimilar);
            return;
        }

        body.classList.add("cpd-menu-loading");
        body.textContent = "Смотрю, на что похоже…";

        try {
            const res = await chrome.runtime.sendMessage({
                type: MSG_SUGGEST,
                payload: { permalink: btn.dataset.cpdPermalink },
            });
            if (!res?.ok) throw new Error(res?.error || "Расширение не ответило");
            if (!openMenu || openMenu !== menu) return; // меню успели закрыть

            menu._cpdSimilar = res.data;
            paintSimilar(menu, btn, res.data);
        } catch (err) {
            if (openMenu !== menu) return;
            body.classList.remove("cpd-menu-loading");
            body.textContent = String(err.message || err);
        }

        placeMenu(menu, btn);
    }

    function paintSimilar(menu, btn, data) {
        const body = menu.querySelector(".cpd-menu-body");
        body.classList.remove("cpd-menu-loading");
        body.textContent = "";

        if (!data.playlists?.length) {
            const empty = document.createElement("div");
            empty.className = "cpd-menu-empty";
            // Причины две и они разные: то ли не на что опереться, то ли
            // опереться было на что, но ничего похожего не нашлось
            empty.textContent = data.needsMeta
                ? "Про этот ролик ничего не известно — coub.com не отдал теги"
                : "Ничего похожего в библиотеке не нашлось";
            body.appendChild(empty);
            return;
        }

        for (const item of data.playlists) {
            body.appendChild(buildSuggestionItem(menu, btn, item));
        }

        if (data.tags?.length) {
            const label = document.createElement("div");
            label.className = "cpd-menu-group";
            label.textContent = "Ваши теги, которые подошли бы";
            body.appendChild(label);

            const tags = document.createElement("div");
            tags.className = "cpd-menu-tags";
            for (const t of data.tags) {
                const chip = document.createElement("span");
                chip.className = "cpd-menu-tag";
                chip.textContent = t.tag;
                tags.appendChild(chip);
            }
            body.appendChild(tags);
        }
    }

    function buildSuggestionItem(menu, btn, item) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cpd-menu-item cpd-menu-item--suggest";

        const name = document.createElement("span");
        name.className = "cpd-menu-name";
        name.textContent = item.name;

        // Из-за каких тегов плейлист и предложен: без этого подсказка
        // выглядит гаданием, а так видно, на чём она стоит
        const why = document.createElement("span");
        why.className = "cpd-menu-why";
        why.textContent = (item.matched || []).join(" · ");

        const text = document.createElement("span");
        text.className = "cpd-menu-text";
        text.append(name, why);

        // Тот же плейлист — та же картинка, что и на соседней вкладке
        row.append(buildBanner(menu._cpdPlaylists?.get(item.name) || { name: item.name }), text);
        row.addEventListener("click", () => {
            closePlaylistMenu();
            download(btn, item.name);
        });

        return row;
    }

    // ─── Создание плейлиста ─────────────────────────────────────────────────

    /**
     * Строка «Новый плейлист» внизу меню. Если в поиске набрано то, чего нет,
     * предлагает завести плейлист прямо с этим именем — набирать второй раз
     * то же самое не придётся.
     */
    function renderFooter(menu, btn, query) {
        const footer = menu.querySelector(".cpd-menu-footer");
        footer.hidden = false;
        footer.textContent = "";

        const create = document.createElement("button");
        create.type = "button";
        create.className = "cpd-menu-item cpd-menu-create";
        create.innerHTML = `
            <span class="cpd-menu-name">
                <svg viewBox="0 0 14 14" aria-hidden="true" width="11" height="11">
                    <path d="M7 2.2v9.6M2.2 7h9.6" fill="none" stroke="currentColor"
                          stroke-width="1.6" stroke-linecap="round"/>
                </svg>
                <span class="cpd-create-label"></span>
            </span>`;
        create.querySelector(".cpd-create-label").textContent = query
            ? `Создать «${query}»`
            : "Новый плейлист";

        create.addEventListener("click", () => startCreate(menu, btn, query));
        footer.appendChild(create);
    }

    /** Превращает строку в поле ввода — prompt() на чужой странице неуместен. */
    function startCreate(menu, btn, initial) {
        const footer = menu.querySelector(".cpd-menu-footer");
        footer.textContent = "";

        const form = document.createElement("form");
        form.className = "cpd-menu-create-form";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "cpd-menu-create-input";
        input.placeholder = "Название плейлиста";
        input.spellcheck = false;
        input.autocomplete = "off";
        input.value = initial || "";

        const submit = document.createElement("button");
        submit.type = "submit";
        submit.className = "cpd-menu-create-submit";
        submit.textContent = "Создать";

        form.append(input, submit);
        footer.appendChild(form);
        input.focus();
        input.select();

        const fail = (text) => {
            input.classList.add("is-error");
            input.title = text;
            submit.disabled = false;
            submit.textContent = "Создать";
        };

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const name = input.value.trim();
            if (!name) return input.focus();

            input.classList.remove("is-error");
            submit.disabled = true;
            submit.textContent = "…";

            try {
                const res = await chrome.runtime.sendMessage({
                    type: MSG_CREATE_PLAYLIST,
                    payload: { name },
                });
                if (!res?.ok) throw new Error(res?.error || "Расширение не ответило");

                // Плейлист создан — сразу кладём в него ролик, ради которого
                // всё и затевалось
                closePlaylistMenu();
                download(btn, res.data.name);
            } catch (err) {
                fail(String(err.message || err));
            }
        });

        input.addEventListener("input", () => input.classList.remove("is-error"));

        // Escape здесь отменяет только создание и возвращает список — закрывать
        // всё меню было бы перебором. Событие гасим, иначе общий обработчик
        // меню закроет его следом
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            renderFooter(menu, btn, initial);
            menu.querySelector(".cpd-menu-search")?.focus();
        });
    }

    function renderMenuItems(menu, btn, { playlists, groupOrder, recent }, query = "") {
        const body = menu.querySelector(".cpd-menu-body");
        body.classList.remove("cpd-menu-loading");
        body.textContent = "";

        if (!playlists.length) {
            body.textContent = "В CoubPlayer пока нет плейлистов";
            return;
        }

        // Умный поиск — тот же, что в плеере: раскладка, транслитерация,
        // опечатки. См. search.js, он подключается перед этим файлом
        const q = query.trim();
        const matched = q
            ? CPD_SEARCH.filterByQuery(playlists, q, (pl) => pl.name)
            : playlists;

        if (!matched.length) {
            body.innerHTML = `<div class="cpd-menu-empty">Ничего не найдено</div>`;
            return;
        }

        // При поиске группы только мешают: на экране и так лишь совпавшее
        const groups = q
            ? [{ name: "", items: matched }]
            : groupPlaylists(matched, groupOrder);

        for (const group of groups) {
            if (group.name) {
                const label = document.createElement("div");
                label.className = "cpd-menu-group";
                label.textContent = group.name;
                body.appendChild(label);
            }
            for (const pl of group.items) {
                body.appendChild(buildMenuItem(btn, pl, recent));
            }
        }
    }

    /**
     * Картинка плейлиста — та же, что в плеере: своя, старый значок или кадр
     * первого ролика; ссылку собирает сервер. Нет ничего — рисуем первую
     * букву, как делает плеер, а не пустой прямоугольник.
     *
     * Картинка идёт с localhost, а страница — с coub.com. Само по себе это
     * не смешанное содержимое (localhost браузер считает доверенным), но
     * сервер может быть и не запущен: тогда onerror оставит букву, и список
     * от этого не пострадает.
     */
    function buildBanner(pl) {
        const box = document.createElement("span");
        box.className = "cpd-menu-banner";

        const letter = document.createElement("span");
        letter.className = "cpd-menu-letter";
        letter.textContent = (pl.name || "?").trim().charAt(0).toUpperCase();
        box.appendChild(letter);

        if (!pl.banner) return box;

        const img = document.createElement("img");
        img.className = "cpd-menu-banner-img";
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("load", () => box.classList.add("has-image"));
        img.src = pl.banner;
        box.appendChild(img);

        return box;
    }

    function buildMenuItem(btn, pl, recent) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cpd-menu-item";
        if (pl.name === recent) row.classList.add("is-recent");
        if (pl.hasCoub) row.classList.add("is-there");

        const name = document.createElement("span");
        name.className = "cpd-menu-name";
        name.textContent = pl.name;

        const note = document.createElement("span");
        note.className = "cpd-menu-note";
        note.textContent = pl.hasCoub ? "уже здесь" : String(pl.count);

        row.append(buildBanner(pl), name, note);
        row.addEventListener("click", () => {
            closePlaylistMenu();
            download(btn, pl.name);
        });

        return row;
    }

    /** Принадлежит ли узел открытому меню. */
    function insideMenu(node) {
        return !!openMenu && node instanceof Node && openMenu.contains(node);
    }

    // Закрываем по нажатию, а не по клику. Клик срабатывает на общем предке
    // точек нажатия и отпускания: потянув ползунок прокрутки и отпустив кнопку
    // мимо меню, пользователь получал click на body — и меню захлопывалось
    // прямо во время прокрутки.
    document.addEventListener(
        "pointerdown",
        (e) => {
            if (insideMenu(e.target)) return;
            // Нажатие на саму кнопку разбирает её обработчик: он переключает
            // меню, и закрывать его здесь заранее нельзя
            if (e.target instanceof Element && e.target.closest(`.${BUTTON_CLASS}`)) return;
            closePlaylistMenu();
        },
        true
    );

    // Прокрутка страницы уводит кнопку из-под меню, поэтому меню закрывается.
    // Но прокрутка списка внутри самого меню — не повод: слушатель стоит
    // в фазе перехвата и видит в том числе события от вложенных элементов.
    document.addEventListener(
        "scroll",
        (e) => {
            if (insideMenu(e.target)) return;
            closePlaylistMenu();
        },
        true
    );

    window.addEventListener("resize", closePlaylistMenu);
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePlaylistMenu();
    });

    // ─── Размещение кнопок ──────────────────────────────────────────────────
    // Разметка coub.com меняется без предупреждения, поэтому кнопка ставится
    // двумя независимыми способами: плавающая — как надёжная опора, и на
    // карточках — как удобство, которое не жалко потерять при редизайне.

    /** Плавающая кнопка на странице отдельного куба. */
    function mountFloating() {
        const permalink = currentPermalink();
        const existing = document.querySelector(".cpd-floating");

        if (!permalink) {
            existing?.remove();
            return;
        }
        if (existing) {
            // SPA-переход на другой куб — просто перенацеливаем кнопку
            const btn = existing.querySelector(`.${BUTTON_CLASS}`);
            if (btn && btn.dataset.cpdPermalink !== permalink) {
                btn.dataset.cpdPermalink = permalink;
                setState(btn, null, DEFAULT_LABEL);
                btn.title = DEFAULT_TITLE;
                btn.classList.remove("is-known");
                askIsDownloaded(btn);
            }
            return;
        }

        const host = document.createElement("div");
        host.className = "cpd-floating";
        host.appendChild(makeButton(permalink));
        document.body.appendChild(host);
    }

    // Карточки ленты.
    //
    // Селектор нарочно узкий. Разметка coub.com — БЭМ, и что-нибудь вроде
    // [class*='coub__'] совпадает с каждым вложенным блоком карточки: кнопка
    // сажалась на все, и абсолютное позиционирование выстраивало их лесенкой
    // по диагонали. Берём только явные признаки самой карточки.
    const CARD_SELECTOR = "[data-permalink], .coub";

    // Предохранитель: разметка сайта нам неподконтрольна, и если селектор
    // однажды снова начнёт совпадать со всем подряд — лучше молча сдаться,
    // чем обклеить страницу кнопками.
    const MAX_CARDS_PER_PAGE = 200;

    let cardsDisabled = false;
    let mountedCount = 0;

    function mountCards() {
        if (cardsDisabled || !cardButtonsEnabled) return;

        for (const card of document.querySelectorAll(CARD_SELECTOR)) {
            if (card.hasAttribute(MARK_ATTR)) continue;

            // Помечаем сразу: даже если кнопка сюда не встанет, второй раз
            // этот элемент разбирать незачем
            card.setAttribute(MARK_ATTR, "1");

            // Карточки вкладываются друг в друга. Обход идёт в порядке
            // документа, то есть внешняя уже помечена — значит всё, что внутри
            // неё, пропускаем. Это и не даёт кнопкам размножаться.
            if (card.parentElement?.closest(`[${MARK_ATTR}]`)) continue;

            // Собственные узлы расширения картинкой карточки быть не могут
            if (card.closest(".cpd-card-slot")) continue;

            const permalink =
                card.getAttribute("data-permalink") ||
                permalinkFromHref(card.querySelector("a[href*='/view/']")?.getAttribute("href"));

            if (!permalink) continue;

            if (++mountedCount > MAX_CARDS_PER_PAGE) {
                cardsDisabled = true;
                console.warn(
                    "[CoubPlayer] слишком много карточек — кнопки на ленте отключены. " +
                    "Похоже, разметка coub.com изменилась и селектор совпадает не с тем."
                );
                return;
            }

            // Кнопка позиционируется absolute — карточке нужна точка отсчёта
            if (getComputedStyle(card).position === "static") {
                card.style.position = "relative";
            }

            const host = document.createElement("div");
            host.className = "cpd-card-slot";
            host.appendChild(makeButton(permalink));
            card.appendChild(host);
        }
    }

    /** Убирает все кнопки с карточек — когда их выключили в попапе. */
    function unmountCards() {
        closePlaylistMenu();
        for (const slot of document.querySelectorAll(".cpd-card-slot")) slot.remove();
        for (const card of document.querySelectorAll(`[${MARK_ATTR}]`)) {
            card.removeAttribute(MARK_ATTR);
        }
        mountedCount = 0;
    }

    // ─── Наблюдение за SPA ──────────────────────────────────────────────────

    let scheduled = false;

    function refresh() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            try {
                mountFloating();
                mountCards();
            } catch (err) {
                console.warn("[CoubPlayer] не удалось разместить кнопку:", err);
            }
        });
    }

    new MutationObserver(refresh).observe(document.documentElement, {
        childList: true,
        subtree: true,
    });

    // История меняется без перезагрузки — ловим и pushState, и «назад»
    const patch = (method) => {
        const original = history[method];
        history[method] = function (...args) {
            const result = original.apply(this, args);
            refresh();
            return result;
        };
    };
    patch("pushState");
    patch("replaceState");
    window.addEventListener("popstate", refresh);

    refresh();
})();
