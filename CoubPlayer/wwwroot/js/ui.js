// ui.js — весь рендеринг UI.
import { getRecentPlaylists, addRecentPlaylist, getRecentTags, addRecentTag } from "./state.js";
import { RANDOM_TRAITS, neutralValue } from "./randomizer.js";
import { findKeyForCoub } from "./playlist.js";
import {
    buildBannerEl,
    bindBannerHover,
    cropBannerImage,
    initBannerCropper,
    forgetLegacyIcon,
} from "./banner.js";
import {
    setPlaylistBanner,
    setPlaylistBannerVideo,
    deletePlaylistBanner,
    deletePlaylistIcon,
} from "./api.js";
import { encodePlaylistShare, decodePlaylistShare } from "./share.js";
import { revealSimple, revealChars } from "./text-reveal.js";








// ─── Go To Start Button ───────────────────────────────────────────────────────

const goToStartBtn = document.getElementById("goToStartBtn");

export function initGoToStartButton(onClick) {
    goToStartBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
        goToStartBtn.blur();
    });
}




// ─── Video Info ───────────────────────────────────────────────────────────────

const videoTitleLabel = document.getElementById("videoTitleLabel");
const videoIndexInput = document.getElementById("videoIndexInput");
const videoTotal = document.getElementById("videoTotal");

export function updateVideoInfo(index, title, total) {
    revealChars(videoTitleLabel, title || "—");
    revealSimple(videoIndexInput, index + 1);
    revealSimple(videoTotal, `/ ${total}`);
}
// ─── Volume Slider ────────────────────────────────────────────────────────────

const volumeSlider = document.getElementById("volumeSlider");

export function initVolumeSlider(onChange, initialValue = 50) {
    const update = (value) => {
        volumeSlider.value = value;
        volumeSlider.style.setProperty("--value", value + "%");
        onChange(value);
    };
    volumeSlider.addEventListener("input", (e) => {
        update(e.target.value);
        volumeSlider.blur()
    });
    update(initialValue);

    return (value) => {
        volumeSlider.value = value;
        volumeSlider.style.setProperty("--value", value + "%");
    };
}

// ─── Copy Link Button ─────────────────────────────────────────────────────────

const copyLinkBtn = document.getElementById("copyLinkBtn");
const copyLinkIconSlot = copyLinkBtn.querySelector(".icon-slot");

const fileDropdown = document.getElementById("fileDropdown");
const fileDropdownBtn = document.getElementById("fileDropdownBtn");
const fileDropdownMenu = document.getElementById("fileDropdownMenu");

export function initCopyLinkBtn(getCurrentVideoId) {
    copyLinkBtn.addEventListener("click", async () => {
        const id = getCurrentVideoId();
        if (!id) return;
        try {
            await navigator.clipboard.writeText(`https://coub.com/view/${id}`);
            flashIconSuccess(copyLinkIconSlot);
            showToast("✓ Ссылка скопирована");
        } catch (e) {
            console.error("Clipboard error:", e);
        }
    });
}

/** Кнопка-список в нижней панели: папка с файлами ролика / его дубликат. */
export function initControlDropdown() {
    const close = () => fileDropdownMenu.classList.add("hidden");

    fileDropdownBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        fileDropdownMenu.classList.toggle("hidden");
        fileDropdownBtn.blur();
    });

    fileDropdownMenu.querySelectorAll(".ctl-dropdown-item").forEach((item) => {
        item.addEventListener("click", close);
    });

    document.addEventListener("click", (e) => {
        if (!fileDropdown.contains(e.target)) close();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
    });
}

let _iconSuccessTimers = new WeakMap();

function flashIconSuccess(iconSlotEl, duration = 1200) {
    if (!iconSlotEl) return;
    clearTimeout(_iconSuccessTimers.get(iconSlotEl));
    iconSlotEl.classList.add("icon-slot--success");
    const t = setTimeout(() => {
        iconSlotEl.classList.remove("icon-slot--success");
    }, duration);
    _iconSuccessTimers.set(iconSlotEl, t);
}

// ─── Sort Bar ─────────────────────────────────────────────────────────────────

const sortTypeGroup = document.getElementById("sortTypeGroup");
const sortDirectionBtn = document.getElementById("sortDirectionBtn");
const seedInput = document.getElementById("seedInput");

const DEFAULT_SEED = 42;

export function initSortBar(onChange, initial = {}) {
    let sortType = initial.sortType ?? "order";
    let sortDirection = initial.sortDirection ?? "asc";
    const madnessShufflesOrder = initial.madnessShufflesOrder ?? (() => true);

    seedInput.value = initial.randomSeed ?? DEFAULT_SEED;

    const activeBtn = sortTypeGroup.querySelector(`[data-type="${sortType}"]`);
    if (activeBtn) {
        [...sortTypeGroup.children].forEach(b => b.classList.remove("active"));
        activeBtn.classList.add("active");
    }

    sortDirectionBtn.textContent = sortDirection === "asc" ? "↑" : "↓";

    syncSortControls(sortType, madnessShufflesOrder());

    const notify = () => onChange(sortType, sortDirection, parseInt(seedInput.value) || DEFAULT_SEED);

    sortTypeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        [...sortTypeGroup.children].forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        sortType = btn.dataset.type;

        syncSortControls(sortType, madnessShufflesOrder());
        notify();
    });

    sortDirectionBtn.addEventListener("click", () => {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
        sortDirectionBtn.textContent = sortDirection === "asc" ? "↑" : "↓";
        notify();
    });

    seedInput.addEventListener("change", () => {
        if (!seedInput.value || parseInt(seedInput.value) < 1) seedInput.value = DEFAULT_SEED;
        notify();
    });
}

/**
 * Показывает/прячет seed и кнопку направления под текущий режим сортировки.
 * Вынесено отдельно, потому что для «Безумия» ответ зависит ещё и от того,
 * включена ли в нём рандомизация порядка: включена — нужен seed, выключена —
 * порядок обычный и снова имеет смысл направление.
 * @param {"order"|"random"|"madness"} sortType
 * @param {boolean} madnessShufflesOrder
 */
export function syncSortControls(sortType, madnessShufflesOrder) {
    const randomOrder =
        sortType === "random" || (sortType === "madness" && madnessShufflesOrder);

    seedInput.classList.toggle("hidden", !randomOrder);
    sortDirectionBtn.classList.toggle("hidden", randomOrder);
}

/** Текущее значение seed из поля верхней панели. */
export function setSeedInput(value) {
    seedInput.value = value;
}

// ─── Madness panel ─────────────────────────────────────────────────────────

const madnessWrap = document.getElementById("madnessWrap");
const madnessTriggerBtn = document.getElementById("madnessSettingsBtn");
const madnessPanel = document.getElementById("madnessPanel");
const madnessClose = document.getElementById("madnessClose");
const madnessList = document.getElementById("madnessList");
const madnessCurrent = document.getElementById("madnessCurrent");
const madnessNoneBtn = document.getElementById("madnessNone");
const madnessAllBtn = document.getElementById("madnessAll");
const madnessReshuffleBtn = document.getElementById("madnessReshuffle");

let _madnessTraits = [];
let _getMadnessState = () => ({});
let _onMadnessChange = null;
let _onMadnessReshuffle = null;

/**
 * @param {{
 *   traits: Array<{key: string, label: string, hint?: string}>,
 *   getEnabled: () => Record<string, boolean>,
 *   onChange: (enabled: Record<string, boolean>) => void,
 *   onReshuffle: () => void,
 * }} options
 */
export function initMadnessPanel({ traits, getEnabled, onChange, onReshuffle }) {
    _madnessTraits = traits;
    _getMadnessState = getEnabled;
    _onMadnessChange = onChange;
    _onMadnessReshuffle = onReshuffle;

    madnessTriggerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMadnessPanel();
    });

    madnessClose.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMadnessPanel();
    });

    madnessList.addEventListener("click", (e) => {
        const row = e.target.closest("[data-trait]");
        if (!row) return;
        e.stopPropagation();
        const enabled = { ..._getMadnessState() };
        enabled[row.dataset.trait] = !enabled[row.dataset.trait];
        _onMadnessChange?.(enabled);
        renderMadnessRows();
    });

    madnessAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setAllMadnessTraits(true);
    });

    madnessNoneBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setAllMadnessTraits(false);
    });

    madnessReshuffleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _onMadnessReshuffle?.();
    });

    document.addEventListener("click", (e) => {
        if (madnessPanel.classList.contains("hidden")) return;
        if (madnessWrap.contains(e.target)) return;
        closeMadnessPanel();
    }, true);

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) return;
        if (e.key === "Escape" && !madnessPanel.classList.contains("hidden")) {
            e.preventDefault();
            e.stopPropagation();
            closeMadnessPanel();
        }
    });

    renderMadnessRows();
}

function setAllMadnessTraits(value) {
    const enabled = {};
    for (const trait of _madnessTraits) enabled[trait.key] = value;
    _onMadnessChange?.(enabled);
    renderMadnessRows();
}

function renderMadnessRows() {
    const enabled = _getMadnessState();
    madnessList.innerHTML = "";

    for (const trait of _madnessTraits) {
        const row = document.createElement("div");
        row.className = "madness-row" + (enabled[trait.key] ? " madness-row--on" : "");
        row.dataset.trait = trait.key;

        const box = document.createElement("div");
        box.className = "madness-box";

        const text = document.createElement("div");
        text.className = "madness-text";

        const label = document.createElement("div");
        label.className = "madness-label";
        label.textContent = trait.label;
        text.appendChild(label);

        if (trait.hint) {
            const hint = document.createElement("div");
            hint.className = "madness-hint";
            hint.textContent = trait.hint;
            text.appendChild(hint);
        }

        row.appendChild(box);
        row.appendChild(text);
        madnessList.appendChild(row);
    }
}

/** Показывает кнопку-шестерёнку только в режиме «Безумие». */
export function setMadnessAvailable(available) {
    madnessTriggerBtn.classList.toggle("hidden", !available);
    if (!available) closeMadnessPanel();
}

export function openMadnessPanel() {
    renderMadnessRows();
    madnessPanel.classList.remove("hidden");
    document.body.classList.add("madness-open");
}

export function closeMadnessPanel() {
    madnessPanel.classList.add("hidden");
    document.body.classList.remove("madness-open");
}

export function isMadnessPanelOpen() {
    return !madnessPanel.classList.contains("hidden");
}

function toggleMadnessPanel() {
    if (madnessPanel.classList.contains("hidden")) openMadnessPanel();
    else closeMadnessPanel();
}

/** Строка с настройками, выпавшими текущему ролику (или "" чтобы скрыть). */
export function setMadnessCurrent(text) {
    madnessCurrent.textContent = text || "";
}

// ─── Transition Mode Toggle (Fade / Flip) ──────────────────────────────────

const transitionModeGroup = document.getElementById("transitionModeGroup");

export function initTransitionModeToggle(onChange, initialMode = "crossfade") {
    const activeBtn = transitionModeGroup.querySelector(`[data-mode="${initialMode}"]`);
    if (activeBtn) {
        [...transitionModeGroup.children].forEach((b) => b.classList.remove("active"));
        activeBtn.classList.add("active");
    }

    transitionModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        [...transitionModeGroup.children].forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        onChange(btn.dataset.mode);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// VIDEO EDITOR — Плейлисты + Теги текущего видео (одно окно, вкладки)
// ═════════════════════════════════════════════════════════════════════════════

const READONLY_PLAYLISTS = ["bookmarks", "liked", "Все"];

// «Все» собирается на лету и на сервере не существует — баннер ему не задать
const VIRTUAL_PLAYLIST = "Все";

const veOverlay = document.getElementById("videoEditorOverlay");
const vePanel = document.getElementById("videoEditorPanel");
const veSubtitle = document.getElementById("videoEditorSubtitle");
const veClose = document.getElementById("videoEditorClose");
const veTabs = document.getElementById("videoEditorTabs");
const veTabPlaylists = document.getElementById("veTabPlaylists");
const veTabTags = document.getElementById("veTabTags");
const veTabFx = document.getElementById("veTabFx");

const editorSearch = document.getElementById("plSearchInput");
const editorClear = document.getElementById("plSearchClear");
const editorList = document.getElementById("plEditorList");
const editorNewBtn = document.getElementById("plNewBtn");

const videoTagsChips = document.getElementById("videoTagsChips");
const videoTagsRecent = document.getElementById("videoTagsRecent");
const videoTagsInput = document.getElementById("videoTagsInput");
const videoTagsAddBtn = document.getElementById("videoTagsAddBtn");
const allTagsDatalist = document.getElementById("allTagsDatalist");

const toast = document.createElement("div");
toast.className = "pl-toast";
document.body.appendChild(toast);

const NAV_EXEMPT_SELECTORS = [
    "#prev", "#next", "#restart", "#fullscreen",
    "#videoIndexWrapper", ".volume-slider", "#copyLinkBtn",
    "#videoEditorPanel", "#videoEditBtn",
];

function isNavExempt(target) {
    return NAV_EXEMPT_SELECTORS.some((sel) => target.closest(sel));
}

let _playlists = {};
let _getEditorPlaylists = null;
let _currentVideoId = null;
let _currentTitle = "";
let _onToggle = null;
let _onCreatePlaylist = null;

let _tagsCurrent = [];
let _onGetCoubTags = null;
let _onAddTag = null;
let _onRemoveTag = null;
let _onTagsChanged = null;
let _suppressNextOverlayClose = false;

let _activeVeTab = "playlists";
let _tagsLoadedForVideo = null; // id видео, для которого уже подгружены теги

export function initVideoEditor({
    getPlaylists, onToggle, onCreatePlaylist,
    getCoubTags, addTag, removeTag, getAllTags, onTagsChanged,
    getFxContext, onFxChange, onDuplicate,
    getPresets, onSavePreset, onDeletePreset,
}) {
    _getFxContext = getFxContext || _getFxContext;
    _onFxChange = onFxChange;
    _onDuplicate = onDuplicate;
    _getPresets = getPresets || _getPresets;
    _onSavePreset = onSavePreset;
    _onDeletePreset = onDeletePreset;
    _getEditorPlaylists = getPlaylists;

    fxBgModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-bgmode]");
        if (!btn || !_getFxContext().editable) return;
        e.stopPropagation();

        _bgSeparate = btn.dataset.bgmode === "separate";
        // Переключились на «вместе» — правим снова видео, фон повторяет его
        if (!_bgSeparate) _fxTarget = "video";
        renderFxRows();
        commitFx();
    });

    fxTargetGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-target]");
        if (!btn) return;
        e.stopPropagation();
        _fxTarget = btn.dataset.target;
        renderFxRows();
    });

    fxPresetsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const willShow = fxPresetsBox.classList.contains("hidden");
        fxPresetsBox.classList.toggle("hidden", !willShow);
        if (willShow) renderPresetRows();
    });

    fxSavePresetBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        _suppressNextOverlayClose = true;

        const name = prompt("Название пресета:");
        if (!name?.trim()) return;

        await _onSavePreset?.({
            name: name.trim(),
            fx: { ..._currentFx },
            bgFx: _bgSeparate ? { ..._currentBgFx } : null,
            bgSeparate: _bgSeparate,
        });

        fxPresetsBox.classList.remove("hidden");
        renderPresetRows();
    });

    fxResetBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _currentFx = {};
        _currentBgFx = {};
        _bgSeparate = false;
        _fxTarget = "video";
        renderFxRows();
        commitFx();
    });

    fxDuplicateBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        _suppressNextOverlayClose = true;
        fxDuplicateBtn.disabled = true;
        try {
            await _onDuplicate?.();
        } finally {
            fxDuplicateBtn.disabled = false;
        }
    });

    _onToggle = onToggle;
    _onCreatePlaylist = onCreatePlaylist;
    _onGetCoubTags = getCoubTags;
    _onAddTag = addTag;
    _onRemoveTag = removeTag;
    _onTagsChanged = onTagsChanged;

    refreshTagsDatalist(getAllTags());

    veClose.addEventListener("click", closeVideoEditor);

    veTabs.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-tab]");
        if (!btn) return;
        switchVeTab(btn.dataset.tab);
    });

    editorSearch.addEventListener("input", () => {
        const q = editorSearch.value.trim();
        editorClear.classList.toggle("hidden", !q);
        renderEditorRows(q);
    });

    editorClear.addEventListener("click", () => {
        editorSearch.value = "";
        editorClear.classList.add("hidden");
        editorSearch.focus();
        renderEditorRows("");
    });

    editorNewBtn.addEventListener("click", async () => {
        if (!_onCreatePlaylist) return;
        const name = await _onCreatePlaylist();
        if (name) {
            _playlists = getPlaylists();
            renderEditorRows(editorSearch.value.trim());
        }
    });

    videoTagsAddBtn.type = "button";
    videoTagsAddBtn.addEventListener("click", commitAddTag);
    videoTagsInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            commitAddTag();
        }
        e.stopPropagation();
    });

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) return;
        if (e.key === "Escape" && veOverlay.classList.contains("show")) closeVideoEditor();
    });

    document.addEventListener("click", (e) => {
        if (_suppressNextOverlayClose) {
            _suppressNextOverlayClose = false;
            return;
        }
        if (
            veOverlay.classList.contains("show") &&
            !vePanel.contains(e.target) &&
            !isNavExempt(e.target)
        ) {
            closeVideoEditor();
        }
    }, true);
}

function switchVeTab(tab) {
    _activeVeTab = tab;

    [...veTabs.children].forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    veTabPlaylists.classList.toggle("pl-tab-hidden", tab !== "playlists");
    veTabTags.classList.toggle("pl-tab-hidden", tab !== "tags");
    veTabFx.classList.toggle("pl-tab-hidden", tab !== "fx");

    if (tab === "tags") {
        loadTagsForCurrentVideo();
        requestAnimationFrame(() => videoTagsInput.focus());
    } else if (tab === "fx") {
        renderFxRows();
    } else {
        renderEditorRows(editorSearch.value.trim());
        requestAnimationFrame(() => editorSearch.focus());
    }

    window.refreshCustomIcons?.();
}

export function openVideoEditor(video, playlists, tab = _activeVeTab) {
    const wasOpen = veOverlay.classList.contains("show");

    _currentVideoId = video.id;
    _currentTitle = video.title || video.id;
    _playlists = playlists;
    _tagsLoadedForVideo = null; // видео сменилось (или открывается впервые) — теги перечитаем
    setFxTarget(video);

    veSubtitle.textContent = _currentTitle;

    if (!wasOpen) {
        editorSearch.value = "";
        editorClear.classList.add("hidden");
    }

    veOverlay.classList.add("show");
    switchVeTab(tab);
}

export function closeVideoEditor() {
    veOverlay.classList.remove("show");
    editorSearch.value = "";
    editorClear.classList.add("hidden");
}

export function toggleVideoEditor(video, playlists, tab = "playlists") {
    if (veOverlay.classList.contains("show")) {
        closeVideoEditor();
    } else {
        openVideoEditor(video, playlists, tab);
    }
}

// ─── Playlists tab ─────────────────────────────────────────────────────────

let _editorRenderGen = 0;

async function renderEditorRows(query) {
    const gen = ++_editorRenderGen;
    editorList.innerHTML = "";
    const q = query.toLowerCase();
    let entries = Object.entries(_playlists).filter(
        ([name]) => !q || name.toLowerCase().includes(q)
    );

    if (!entries.length) {
        if (gen !== _editorRenderGen) return;
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = query ? "Ничего не найдено" : "Нет плейлистов";
        editorList.appendChild(empty);
        return;
    }

    if (!q) {
        const recentNames = getRecentPlaylists().filter((n) => _playlists[n]);
        const recentSet = new Set(recentNames);
        const recentEntries = recentNames.map((name) => [name, _playlists[name]]);
        const restEntries = entries.filter(([name]) => !recentSet.has(name));

        if (recentEntries.length) {
            const label = document.createElement("div");
            label.className = "pl-section-label";
            label.textContent = "Недавние";
            if (gen !== _editorRenderGen) return;
            editorList.appendChild(label);
            for (const [name, data] of recentEntries) {
                const row = await buildEditorRow(name, data);
                if (gen !== _editorRenderGen) return;
                editorList.appendChild(row);
            }
            if (restEntries.length) {
                const label2 = document.createElement("div");
                label2.className = "pl-section-label";
                label2.textContent = "Все плейлисты";
                if (gen !== _editorRenderGen) return;
                editorList.appendChild(label2);
            }
        }
        entries = restEntries;
    }

    for (const [name, data] of entries) {
        const row = await buildEditorRow(name, data);
        if (gen !== _editorRenderGen) return;
        editorList.appendChild(row);
    }

    window.refreshCustomIcons?.();
}

async function buildEditorRow(name, data) {
    // ролик может лежать в плейлисте копией ("id#2"), поэтому ищем по id куба
    const isChecked = !!findKeyForCoub(data.videos, _currentVideoId);
    const isReadonly = READONLY_PLAYLISTS.includes(name);
    const count = Object.keys(data.videos || {}).length;

    const row = document.createElement("div");
    row.className = ["pl-row", "pl-row--banner",
        isChecked ? "pl-row--checked" : "",
        isReadonly ? "pl-row--readonly" : "",
    ].filter(Boolean).join(" ");

    const icon = await buildListBanner(name, data, {
        className: "pl-row-icon",
        hoverTarget: row,
    });

    const text = document.createElement("div");
    text.className = "pl-row-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-row-name";
    nameEl.textContent = name;

    const countEl = document.createElement("div");
    countEl.className = "pl-row-count";
    countEl.textContent = `${count} видео`;

    text.appendChild(nameEl);
    text.appendChild(countEl);

    const check = document.createElement("div");
    check.className = "pl-row-check";

    row.appendChild(icon);
    row.appendChild(text);

    if (name !== VIRTUAL_PLAYLIST) {
        const actions = document.createElement("div");
        actions.className = "pl-row-actions";
        actions.appendChild(buildBannerButton(name, row));
        row.appendChild(actions);
    }

    row.appendChild(check);

    if (!isReadonly) {
        row.addEventListener("click", (e) => {
            if (e.target.closest(".pl-row-actions, .pl-banner-menu")) return;
            handleToggle(row, name, data, countEl);
        });
    }
    return row;
}

async function handleToggle(row, name, data, countEl) {
    const wasChecked = row.classList.contains("pl-row--checked");
    const add = !wasChecked;

    row.classList.toggle("pl-row--checked", add);
    data.videos = data.videos || {};

    const existingKey = findKeyForCoub(data.videos, _currentVideoId);
    if (add) {
        data.videos[_currentVideoId] = { title: _currentTitle };
    } else if (existingKey) {
        delete data.videos[existingKey];
    }

    countEl.textContent = `${Object.keys(data.videos).length} видео`;
    showToast(add
        ? `<span class="pl-toast-accent">+</span> Добавлено в «${name}»`
        : `Удалено из «${name}»`
    );

    try {
        await _onToggle(name, add);
        addRecentPlaylist(name);
    } catch (err) {
        row.classList.toggle("pl-row--checked", wasChecked);
        if (wasChecked) {
            data.videos[_currentVideoId] = { title: _currentTitle };
        } else {
            delete data.videos[_currentVideoId];
        }
        countEl.textContent = `${Object.keys(data.videos).length} видео`;
        showToast("⚠ Ошибка сохранения");
        console.error("Playlist toggle error:", err);
    }
}

let _toastTimer = null;
export function showToast(html) {
    toast.innerHTML = html;
    toast.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

export function syncVideoEditorToVideo(video) {
    _currentVideoId = video.id;
    _currentTitle = video.title || video.id;
    _tagsLoadedForVideo = null;
    setFxTarget(video);

    if (!veOverlay.classList.contains("show")) return;

    veSubtitle.textContent = _currentTitle;
    if (_activeVeTab === "tags") {
        loadTagsForCurrentVideo();
    } else if (_activeVeTab === "fx") {
        renderFxRows();
    } else {
        renderEditorRows(editorSearch.value.trim());
    }
}

// ─── Shared helpers (баннеры плейлистов) ───────────────────────────────────

let _getCoubMap = () => ({});
let _onBannerChanged = null;

/** Данные плейлиста по имени — из того источника, который сейчас свежее. */
function playlistDataFor(name) {
    return _getSelectorPlaylists?.()[name] || _playlists[name] || null;
}

/**
 * Перерисовывает оба списка плейлистов после смены баннера.
 * Данные о баннере лежат в playlists.json, поэтому сначала просим main.js
 * перечитать их с сервера.
 */
async function afterBannerChange() {
    await _onBannerChanged?.();

    if (_getSelectorPlaylists) _selectorPlaylists = _getSelectorPlaylists();
    if (_getEditorPlaylists) _playlists = _getEditorPlaylists();

    if (sortingOverlay.classList.contains("show") && _activeSortingTab === "playlists") {
        renderSelectorRows(sortingSearch.value.trim());
    }
    if (veOverlay.classList.contains("show") && _activeVeTab === "playlists") {
        renderEditorRows(editorSearch.value.trim());
    }
}

function pickFile(accept) {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
        input.click();
    });
}

let _openBannerMenu = null;

function closeBannerMenu() {
    _openBannerMenu?.remove();
    _openBannerMenu = null;
}

/**
 * Ставит меню рядом с кнопкой, разворачивая его вверх или влево,
 * если внизу/справа не хватает места.
 */
function positionBannerMenu(menu, anchor) {
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const GAP = 6;
    const EDGE = 8;

    let left = a.left;
    if (left + m.width > window.innerWidth - EDGE) {
        left = window.innerWidth - m.width - EDGE;
    }

    let top = a.bottom + GAP;
    if (top + m.height > window.innerHeight - EDGE) {
        top = a.top - m.height - GAP;
    }

    menu.style.left = `${Math.max(EDGE, left)}px`;
    menu.style.top = `${Math.max(EDGE, top)}px`;
}

/**
 * Меню баннера: своя картинка (с кадрированием), свой ролик, сброс к превью
 * первого видео плейлиста.
 *
 * Меню живёт в body, а не внутри плитки: список плейлистов прокручиваемый
 * (overflow: auto) и обрезал бы его, а соседние плитки, нарисованные позже,
 * перекрывали бы его собой.
 * @param {HTMLElement} anchor — кнопка, у которой раскрыть меню
 * @param {string} name
 */
function openBannerMenu(anchor, name) {
    closeBannerMenu();

    const data = playlistDataFor(name);
    const menu = document.createElement("div");
    menu.className = "pl-banner-menu";

    const addItem = (label, disabled, onClick) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pl-banner-menu-item";
        btn.textContent = label;
        btn.disabled = !!disabled;
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            closeBannerMenu();
            await onClick();
        });
        menu.appendChild(btn);
    };

    addItem("Своя картинка…", false, () => pickBannerImage(name));
    addItem("Свой ролик…", false, () => pickBannerVideo(name));

    const sep = document.createElement("div");
    sep.className = "pl-banner-menu-sep";
    menu.appendChild(sep);

    addItem("Сбросить картинку", !data?.banner?.image, () => resetBanner(name, "image"));
    addItem("Сбросить анимацию", !data?.banner?.video, () => resetBanner(name, "video"));

    document.body.appendChild(menu);
    positionBannerMenu(menu, anchor);
    _openBannerMenu = menu;
}

async function pickBannerImage(name) {
    const file = await pickFile("image/*");
    if (!file) return;

    _suppressNextOverlayClose = true;
    const blob = await cropBannerImage(file, name);
    if (!blob) return;

    try {
        await setPlaylistBanner(name, blob);
        await afterBannerChange();
        showToast(`<span class="pl-toast-accent">✦</span> Баннер «${name}» обновлён`);
    } catch (err) {
        console.error("Banner upload error:", err);
        showToast("⚠ Не удалось загрузить баннер");
    }
}

async function pickBannerVideo(name) {
    const file = await pickFile("video/mp4,video/webm");
    if (!file) return;

    _suppressNextOverlayClose = true;
    try {
        await setPlaylistBannerVideo(name, file);
        await afterBannerChange();
        showToast(`<span class="pl-toast-accent">✦</span> Анимация «${name}» обновлена`);
    } catch (err) {
        console.error("Banner video upload error:", err);
        showToast("⚠ " + err.message);
    }
}

async function resetBanner(name, kind) {
    _suppressNextOverlayClose = true;
    try {
        await deletePlaylistBanner(name, kind);
        if (kind === "image") {
            // старая иконка плейлиста тоже считается «своей картинкой»
            await deletePlaylistIcon(name).catch(() => { });
            forgetLegacyIcon(name);
        }
        await afterBannerChange();
    } catch (err) {
        console.error("Banner reset error:", err);
        showToast("⚠ Не удалось сбросить баннер");
    }
}

/**
 * Баннер для списка: собирает элемент и включает анимацию по наведению.
 * Сам баннер не кликабелен — он лежит фоном под всей кнопкой, а её клик
 * занят основным действием (выбрать плейлист / добавить в него ролик).
 * Меню баннера открывается отдельной кнопкой (см. buildBannerButton).
 */
async function buildListBanner(name, data, { className, hoverTarget }) {
    const banner = await buildBannerEl(name, data, { coubMap: _getCoubMap() });
    banner.classList.add(className);
    bindBannerHover(hoverTarget, banner);
    return banner;
}

/** Кнопка вызова меню баннера — появляется при наведении на строку/плитку. */
function buildBannerButton(name, anchor) {
    const btn = document.createElement("button");
    btn.className = "pl-row-action-btn pl-row-icon-btn";
    btn.title = "Баннер плейлиста";
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/><path d="M2.5 11.5L6 8l2 2 3-3.5 2.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBannerMenu(btn, name);
    });
    return btn;
}

// ─── Tags tab ──────────────────────────────────────────────────────────────

export function refreshTagsDatalist(allTags) {
    allTagsDatalist.innerHTML = "";
    for (const { tag } of allTags) {
        const opt = document.createElement("option");
        opt.value = tag;
        allTagsDatalist.appendChild(opt);
    }
}

async function loadTagsForCurrentVideo() {
    if (!_currentVideoId) return;
    if (_tagsLoadedForVideo === _currentVideoId) return; // уже подгружено для этого видео

    videoTagsChips.innerHTML = `<div class="pl-empty">Загрузка…</div>`;
    videoTagsRecent.innerHTML = "";
    try {
        const res = await _onGetCoubTags(_currentVideoId);
        const list = Array.isArray(res) ? res : res.tags || [];
        _tagsCurrent = list.map((t) => (typeof t === "string" ? t : t.tag));
        _tagsLoadedForVideo = _currentVideoId;
        renderTagChips();
        renderRecentTagSuggestions();
    } catch (err) {
        videoTagsChips.innerHTML = `<div class="pl-empty">Ошибка загрузки тегов</div>`;
        console.error("Tags load error:", err);
    }
}

function renderRecentTagSuggestions() {
    videoTagsRecent.innerHTML = "";
    const recent = getRecentTags().filter((t) => !_tagsCurrent.includes(t));
    if (!recent.length) return;

    const label = document.createElement("span");
    label.className = "video-tags-recent-label";
    label.textContent = "Недавние:";
    videoTagsRecent.appendChild(label);

    for (const tag of recent) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tag-chip tag-chip--suggest";
        chip.textContent = tag;
        chip.addEventListener("click", () => quickAddTag(tag));
        videoTagsRecent.appendChild(chip);
    }
}

async function quickAddTag(tag) {
    if (!tag || !_currentVideoId || _tagsCurrent.includes(tag)) return;
    _suppressNextOverlayClose = true;
    _tagsCurrent.push(tag);
    renderTagChips();
    renderRecentTagSuggestions();

    try {
        await _onAddTag(_currentVideoId, tag);
        addRecentTag(tag);
        _onTagsChanged?.();
    } catch (err) {
        _tagsCurrent = _tagsCurrent.filter((t) => t !== tag);
        renderTagChips();
        renderRecentTagSuggestions();
        showToast("⚠ Не удалось добавить тег");
        console.error("Add tag error:", err);
    }
}

function renderTagChips() {
    videoTagsChips.innerHTML = "";
    if (!_tagsCurrent.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = "Тегов пока нет";
        videoTagsChips.appendChild(empty);
        return;
    }
    for (const tag of _tagsCurrent) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";

        const label = document.createElement("span");
        label.textContent = tag;

        const remove = document.createElement("button");
        remove.className = "tag-chip-remove";
        remove.textContent = "✕";
        remove.title = "Удалить тег";
        remove.addEventListener("click", () => removeTagChip(tag, chip));

        chip.appendChild(label);
        chip.appendChild(remove);
        videoTagsChips.appendChild(chip);
    }
}

async function commitAddTag() {
    const tag = videoTagsInput.value.trim();
    if (!tag || !_currentVideoId) return;
    if (_tagsCurrent.includes(tag)) {
        showToast("⚠ Тег уже добавлен");
        videoTagsInput.value = "";
        return;
    }

    _suppressNextOverlayClose = true;
    videoTagsInput.value = "";
    _tagsCurrent.push(tag);
    renderTagChips();
    renderRecentTagSuggestions();

    try {
        await _onAddTag(_currentVideoId, tag);
        addRecentTag(tag);
        _onTagsChanged?.();
    } catch (err) {
        _tagsCurrent = _tagsCurrent.filter((t) => t !== tag);
        renderTagChips();
        renderRecentTagSuggestions();
        showToast("⚠ Не удалось добавить тег");
        console.error("Add tag error:", err);
    }

    requestAnimationFrame(() => videoTagsInput.focus());
}

async function removeTagChip(tag, chipEl) {
    const prev = [..._tagsCurrent];
    _tagsCurrent = _tagsCurrent.filter((t) => t !== tag);
    _suppressNextOverlayClose = true;
    chipEl.remove();

    try {
        await _onRemoveTag(_currentVideoId, tag);
        _onTagsChanged?.();
        renderRecentTagSuggestions();
    } catch (err) {
        _tagsCurrent = prev;
        renderTagChips();
        showToast("⚠ Не удалось удалить тег");
        console.error("Remove tag error:", err);
    }
}

// ─── Fx tab (персональная постобработка ролика) ────────────────────────────

const fxList = document.getElementById("fxList");
const fxNote = document.getElementById("fxNote");
const fxResetBtn = document.getElementById("fxResetBtn");
const fxDuplicateBtn = document.getElementById("fxDuplicateBtn");
const fxBgModeGroup = document.getElementById("fxBgModeGroup");
const fxTargetRow = document.getElementById("fxTargetRow");
const fxTargetGroup = document.getElementById("fxTargetGroup");
const fxPresetsBtn = document.getElementById("fxPresetsBtn");
const fxSavePresetBtn = document.getElementById("fxSavePresetBtn");
const fxPresetsBox = document.getElementById("fxPresetsBox");
const fxPresetsList = document.getElementById("fxPresetsList");

// Настройки уровня плейлиста (порядок) к постобработке не относятся
const FX_TRAITS = RANDOM_TRAITS.filter((t) => t.scope !== "playlist");
// Фон рисуется канвасом по кадрам активного видео и повторяет его темп сам —
// отдельную скорость ему задать нельзя
const FX_BG_TRAITS = FX_TRAITS.filter((t) => t.scope !== "playback");

let _currentVideoKey = null;
let _currentFx = {};
let _currentBgFx = {};
let _bgSeparate = false;
let _fxTarget = "video"; // что правят ползунки: "video" | "bg"
let _onFxChange = null;
let _onDuplicate = null;
let _getFxContext = () => ({ editable: true, note: "" });
let _getPresets = () => [];
let _onSavePreset = null;
let _onDeletePreset = null;
let _onApplyPreset = null;

/** Набор значений, который сейчас правят ползунки. */
function activeFxValues() {
    return _fxTarget === "bg" ? _currentBgFx : _currentFx;
}

/** Список настроек, доступных для текущей цели. */
function activeFxTraits() {
    return _fxTarget === "bg" ? FX_BG_TRAITS : FX_TRAITS;
}

/** Диапазон ползунка для настройки. mirror — «переключатель» 0/1. */
function fxSliderConfig(trait) {
    if (trait.key === "mirror") return { min: 0, max: 1, step: 1 };
    const step = trait.key === "hue" || trait.key === "rotate" ? 1
        : trait.key === "blur" ? 0.1
            : 0.05;
    return { min: trait.min, max: trait.max, step };
}

function fxFormatValue(trait, value) {
    if (trait.key === "mirror") return value ? "да" : "нет";
    if (trait.key === "speed") return `${Number(value).toFixed(2)}×`;
    if (trait.suffix === "deg") return `${Math.round(value)}°`;
    if (trait.suffix === "px") return `${Number(value).toFixed(1)}px`;
    return Number(value).toFixed(2);
}

function renderFxRows() {
    const { editable, note } = _getFxContext();

    fxNote.textContent = note || "";
    fxNote.classList.toggle("fx-note--warn", !editable && !!note);
    fxResetBtn.disabled = !editable;
    fxDuplicateBtn.disabled = !editable;
    fxSavePresetBtn.disabled = !editable;

    // Цель правки нужна, только когда фон настраивается отдельно
    fxTargetRow.classList.toggle("hidden", !_bgSeparate);
    [...fxBgModeGroup.children].forEach((b) =>
        b.classList.toggle("active", (b.dataset.bgmode === "separate") === _bgSeparate)
    );
    [...fxTargetGroup.children].forEach((b) =>
        b.classList.toggle("active", b.dataset.target === _fxTarget)
    );

    const values = activeFxValues();
    fxList.innerHTML = "";
    for (const trait of activeFxTraits()) {
        fxList.appendChild(buildFxRow(trait, editable, values));
    }
}

function buildFxRow(trait, editable, values) {
    const isOn = trait.key in values;
    const cfg = fxSliderConfig(trait);
    const value = isOn ? Number(values[trait.key]) : neutralValue(trait.key);

    const row = document.createElement("div");
    row.className = "fx-row" + (isOn ? " fx-row--on" : "");
    row.dataset.trait = trait.key;

    const head = document.createElement("div");
    head.className = "fx-row-head";

    const box = document.createElement("div");
    box.className = "madness-box";

    const label = document.createElement("div");
    label.className = "fx-row-label";
    label.textContent = trait.label;

    const valueEl = document.createElement("div");
    valueEl.className = "fx-row-value";
    valueEl.textContent = isOn ? fxFormatValue(trait, value) : "—";

    head.appendChild(box);
    head.appendChild(label);
    head.appendChild(valueEl);

    const control = document.createElement("div");
    control.className = "fx-row-control";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "fx-slider";
    slider.min = cfg.min;
    slider.max = cfg.max;
    slider.step = cfg.step;
    slider.value = value;
    slider.disabled = !editable;
    control.appendChild(slider);

    row.appendChild(head);
    row.appendChild(control);

    if (!editable) return row;

    head.addEventListener("click", () => {
        if (trait.key in values) delete values[trait.key];
        else values[trait.key] = Number(slider.value);

        const on = trait.key in values;
        row.classList.toggle("fx-row--on", on);
        valueEl.textContent = on ? fxFormatValue(trait, values[trait.key]) : "—";
        commitFx();
    });

    slider.addEventListener("input", () => {
        values[trait.key] = Number(slider.value);
        row.classList.add("fx-row--on");
        valueEl.textContent = fxFormatValue(trait, values[trait.key]);
        commitFx();
    });

    return row;
}

// Ползунок сыплет событиями непрерывно: к плееру применяем сразу (чтобы
// эффект был виден прямо во время перетаскивания), а на сервер пишем с
// задержкой, иначе получим сотню запросов на одно движение.
let _fxSaveTimer = null;

function commitFx() {
    const snapshot = {
        fx: { ..._currentFx },
        bgFx: { ..._currentBgFx },
        bgSeparate: _bgSeparate,
    };
    _onFxChange?.(_currentVideoKey, snapshot, { persist: false });

    clearTimeout(_fxSaveTimer);
    _fxSaveTimer = setTimeout(() => {
        _onFxChange?.(_currentVideoKey, snapshot, { persist: true });
    }, 350);
}

/** Подставить в редактор постобработку другого ролика. */
function setFxTarget(video) {
    _currentVideoKey = video?.key ?? null;
    _currentFx = { ...(video?.fx || {}) };
    _currentBgFx = { ...(video?.bgFx || {}) };
    _bgSeparate = !!video?.bgSeparate;
    if (!_bgSeparate) _fxTarget = "video";
    if (_activeVeTab === "fx") renderFxRows();
}

// ─── Пресеты постобработки ─────────────────────────────────────────────────

function renderPresetRows() {
    const presets = _getPresets() || [];
    fxPresetsList.innerHTML = "";

    if (!presets.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = "Пресетов пока нет";
        fxPresetsList.appendChild(empty);
        return;
    }

    for (const preset of presets) {
        fxPresetsList.appendChild(buildPresetRow(preset));
    }
}

function buildPresetRow(preset) {
    const row = document.createElement("div");
    row.className = "fx-preset-row";
    row.title = `Применить «${preset.name}» к этому ролику`;

    const name = document.createElement("div");
    name.className = "fx-preset-name";
    name.textContent = preset.name;

    const meta = document.createElement("div");
    meta.className = "fx-preset-meta";
    const count = Object.keys(preset.fx || {}).length;
    meta.textContent = preset.bgSeparate ? `${count} + фон` : `${count}`;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "fx-preset-del";
    del.textContent = "✕";
    del.title = "Удалить пресет";
    del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Удалить пресет «${preset.name}»?`)) return;
        _suppressNextOverlayClose = true;
        await _onDeletePreset?.(preset.name);
        renderPresetRows();
    });

    row.appendChild(name);
    row.appendChild(meta);
    row.appendChild(del);

    row.addEventListener("click", (e) => {
        e.stopPropagation();
        _suppressNextOverlayClose = true;
        applyPresetToCurrent(preset);
    });

    return row;
}

function applyPresetToCurrent(preset) {
    _currentFx = { ...(preset.fx || {}) };
    _currentBgFx = { ...(preset.bgFx || {}) };
    _bgSeparate = !!preset.bgSeparate;
    if (!_bgSeparate) _fxTarget = "video";
    renderFxRows();
    commitFx();
    showToast(`<span class="pl-toast-accent">✦</span> Пресет «${preset.name}» применён`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SORTING PANEL — Плейлисты + Теги в одном окне (табы)
// ═════════════════════════════════════════════════════════════════════════════

const sortingOverlay = document.getElementById("sortingOverlay");
const sortingPanel = document.getElementById("sortingPanel");
const sortingClose = document.getElementById("sortingClose");
const sortingTitle = document.getElementById("sortingTitle");
const sortingSubtitle = document.getElementById("sortingSubtitle");
const sortingTabs = document.getElementById("sortingTabs");
const sortingSearch = document.getElementById("sortingSearch");
const sortingSearchClear = document.getElementById("sortingSearchClear");
const tagFilterModeGroup = document.getElementById("tagFilterModeGroup");

const plSelectorList = document.getElementById("plSelectorList");
const tagFilterListEl = document.getElementById("tagFilterList");
const sortingFooterPlaylists = document.getElementById("sortingFooterPlaylists");
const sortingFooterTags = document.getElementById("sortingFooterTags");
const plSelectorNewBtn = document.getElementById("plSelectorNewBtn");
const tagFilterClearBtn = document.getElementById("tagFilterClearBtn");
const tagFilterDeleteAllBtn = document.getElementById("tagFilterDeleteAllBtn");

const playlistTriggerBtn = document.getElementById("playlistTriggerBtn");
const playlistTriggerLabel = document.getElementById("playlistTriggerLabel");

const INVALID_CHARS = /[\/\\:*?"<>|]/;
const SANITIZE_CHARS = /[\/\\:*?"<>|]/g;
const READONLY_SELECTOR = ["bookmarks", "liked", "Все"];

// state — playlists
let _selectorPlaylists = {};
let _selectorSelected = null;
let _onSelectPlaylist = null;
let _onCreateFromSelector = null;
let _onDeletePlaylist = null;
let _onRenamePlaylist = null;
let _getSelectorPlaylists = null;

// state — tags
let _allTagsCache = [];
let _activeTags = [];
let _tagMode = "any";
let _onTagFilterChange = null;
let _getAllTags = null;
let _getActiveTags = null;
let _getTagMode = null;
let _onRenameTag = null;   // NEW
let _onDeleteTag = null;   // NEW
let _onDeleteAllTags = null;   // NEW

let _activeSortingTab = "playlists";

export function initSortingPanel({
    getPlaylists, onSelect, onCreate, onDelete, onRename,
    getAllTags, getActiveTagFilter, getTagFilterMode, onTagFilterChange,
    onRenameTag, onDeleteTag, onDeleteAllTags,   // NEW
    getCoubMap, onBannerChanged,
}) {
    _getCoubMap = getCoubMap || _getCoubMap;
    _onBannerChanged = onBannerChanged;
    initBannerCropper();

    _onSelectPlaylist = onSelect;
    _onCreateFromSelector = onCreate;
    _onDeletePlaylist = onDelete;
    _onRenamePlaylist = onRename;
    _getSelectorPlaylists = getPlaylists;

    _getAllTags = getAllTags;
    _getActiveTags = getActiveTagFilter;
    _getTagMode = getTagFilterMode;
    _onTagFilterChange = onTagFilterChange;
    _onRenameTag = onRenameTag;
    _onDeleteTag = onDeleteTag;
    _onDeleteAllTags = onDeleteAllTags;   // NEW

    // Триггер — открывает окно (вкладка "Плейлисты" по умолчанию;
    // на "Теги" переключаются уже внутри окна через табы)
    playlistTriggerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openSortingPanel("playlists");
    });

    sortingClose.addEventListener("click", closeSortingPanel);

    sortingTabs.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-tab]");
        if (!btn) return;
        switchSortingTab(btn.dataset.tab);
    });

    sortingSearch.addEventListener("input", () => {
        const q = sortingSearch.value.trim();
        sortingSearchClear.classList.toggle("hidden", !q);
        renderActiveTab(q);
    });

    sortingSearchClear.addEventListener("click", () => {
        sortingSearch.value = "";
        sortingSearchClear.classList.add("hidden");
        sortingSearch.focus();
        renderActiveTab("");
    });

    tagFilterModeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-mode]");
        if (!btn) return;
        _tagMode = btn.dataset.mode;
        syncTagModeButtons();
        notifyTagFilterChange();
    });
    tagFilterDeleteAllBtn.addEventListener("click", handleDeleteAllTags);
    tagFilterClearBtn.addEventListener("click", () => {
        _activeTags = [];
        renderActiveTab(sortingSearch.value.trim());
        notifyTagFilterChange();
    });

    plSelectorNewBtn.addEventListener("click", async () => {
        if (!_onCreateFromSelector) return;
        const name = await _onCreateFromSelector();
        if (name) {
            _selectorPlaylists = _getSelectorPlaylists();
            renderActiveTab(sortingSearch.value.trim());
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) return;
        if (e.key === "Escape" && sortingOverlay.classList.contains("show")) closeSortingPanel();
    });

    // Меню баннера закрывается по клику мимо него; оно позиционировано
    // фиксированно, поэтому при прокрутке списка его тоже надо убирать
    document.addEventListener("click", (e) => {
        if (!_openBannerMenu) return;
        if (_openBannerMenu.contains(e.target)) return;
        if (e.target.closest(".pl-row-icon-btn")) return;
        closeBannerMenu();
    }, true);

    document.addEventListener("scroll", closeBannerMenu, true);
    window.addEventListener("resize", closeBannerMenu);

    document.addEventListener("click", (e) => {
        if (
            sortingOverlay.classList.contains("show") &&
            !sortingPanel.contains(e.target) &&
            !e.target.closest("#playlistTriggerBtn")
        ) {
            closeSortingPanel();
        }
    }, true); // NEW

}

function openSortingPanel(tab) {
    _selectorPlaylists = _getSelectorPlaylists();
    _allTagsCache = _getAllTags();
    _activeTags = [..._getActiveTags()];
    _tagMode = _getTagMode();
    syncTagModeButtons();

    sortingSearch.value = "";
    sortingSearchClear.classList.add("hidden");

    switchSortingTab(tab);
    window.refreshCustomIcons?.();
    sortingOverlay.classList.add("show");
    requestAnimationFrame(() => sortingSearch.focus());
}

function closeSortingPanel() {
    sortingOverlay.classList.remove("show");
}

function switchSortingTab(tab) {
    _activeSortingTab = tab;
    const isTags = tab === "tags";

    [...sortingTabs.children].forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

    tagFilterModeGroup.hidden = !isTags;
    plSelectorList.classList.toggle("pl-tab-hidden", isTags);
    tagFilterListEl.classList.toggle("pl-tab-hidden", !isTags);
    sortingFooterPlaylists.classList.toggle("pl-tab-hidden", isTags);
    sortingFooterTags.classList.toggle("pl-tab-hidden", !isTags);

    sortingTitle.textContent = isTags ? "Теги" : "Плейлисты";
    sortingSearch.placeholder = isTags ? "Найти тег…" : "Найти плейлист…";

    sortingSearch.value = "";
    sortingSearchClear.classList.add("hidden");

    updateSortingSubtitle();
    renderActiveTab("");

    window.refreshCustomIcons?.();
}

function updateSortingSubtitle() {
    if (_activeSortingTab === "tags") {
        sortingSubtitle.textContent = _activeTags.length
            ? `${_activeTags.length} тег(ов) · ${_tagMode === "any" ? "любой из" : "все сразу"}`
            : "Все видео";
    } else {
        sortingSubtitle.textContent = "Выберите плейлист";
    }
}

function renderActiveTab(query) {
    if (_activeSortingTab === "tags") renderTagFilterRows(query);
    else renderSelectorRows(query);
}

function syncTagModeButtons() {
    [...tagFilterModeGroup.children].forEach((b) =>
        b.classList.toggle("active", b.dataset.mode === _tagMode)
    );
}

// ─── Playlists tab ─────────────────────────────────────────────────────────

let _selectorRenderGen = 0; // NEW

async function renderSelectorRows(query) {
    const gen = ++_selectorRenderGen; // NEW
    plSelectorList.innerHTML = "";
    const q = query.toLowerCase();
    let entries = Object.entries(_selectorPlaylists).filter(
        ([name]) => !q || name.toLowerCase().includes(q)
    );

    entries = sortPlaylistEntries(entries);

    if (!entries.length) {
        if (gen !== _selectorRenderGen) return; // NEW
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = query ? "Ничего не найдено" : "Нет плейлистов";
        plSelectorList.appendChild(empty);
        return;
    }

    for (const [name, data] of entries) {
        const row = await buildSelectorRow(name, data);
        if (gen !== _selectorRenderGen) return; // NEW
        plSelectorList.appendChild(row);
    }

    window.refreshCustomIcons?.();
}

const PRIORITY_ORDER = ["Все", "bookmarks", "liked"];

function sortPlaylistEntries(entries) {
    return entries.sort(([aName], [bName]) => {
        const aIdx = PRIORITY_ORDER.indexOf(aName);
        const bIdx = PRIORITY_ORDER.indexOf(bName);
        if (aIdx === -1 && bIdx === -1) return 0; // стабильная сортировка сохранит остальной порядок
        if (aIdx === -1) return 1;
        if (bIdx === -1) return -1;
        return aIdx - bIdx;
    });
}

async function buildSelectorRow(name, data) {
    const count = Object.keys(data.videos || {}).length;
    const isActive = name === _selectorSelected;
    const isRO = READONLY_SELECTOR.includes(name);

    const tile = document.createElement("div");
    tile.className = "pl-tile pl-tile--banner" + (isActive ? " pl-tile--active" : "");

    const thumb = await buildListBanner(name, data, {
        className: "pl-tile-thumb",
        hoverTarget: tile,
    });
    tile.appendChild(thumb);

    const text = document.createElement("div");
    text.className = "pl-tile-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-tile-name pl-row-name";
    nameEl.textContent = name;

    const countEl = document.createElement("div");
    countEl.className = "pl-tile-count";
    countEl.textContent = `${count} видео`;

    text.appendChild(nameEl);
    text.appendChild(countEl);
    tile.appendChild(text);

    const check = document.createElement("div");
    check.className = "pl-row-check";
    tile.appendChild(check);

    tile.addEventListener("click", (e) => {
        if (e.target.closest(".pl-row-actions, .pl-banner-menu")) return;
        _selectorSelected = name;
        closeSortingPanel();
        setPlaylistTriggerLabel(name);
        _onSelectPlaylist(name);
    });

    const actions = document.createElement("div");
    actions.className = "pl-row-actions";

    const shareBtn = document.createElement("button");
    shareBtn.className = "pl-row-action-btn pl-row-share-btn";
    shareBtn.title = "Поделиться плейлистом";
    shareBtn.innerHTML = `<span class="icon-slot" data-icon-name="copy-link">
    <span class="icon-fallback">🔗</span>
    <img class="icon-custom" alt="" draggable="false" />
    <span class="icon-check" data-icon-name="success">
        <span class="icon-check-fallback">✓</span>
        <img class="icon-custom" alt="" draggable="false" />
    </span>
</span>`;
    shareBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const iconSlot = shareBtn.querySelector(".icon-slot");
        await handleSharePlaylist(name, data, iconSlot);
    });

    actions.appendChild(shareBtn);

    if (name !== VIRTUAL_PLAYLIST) {
        actions.appendChild(buildBannerButton(name, tile));
    }

    if (!isRO) {
        const renameBtn = document.createElement("button");
        renameBtn.className = "pl-row-action-btn pl-row-rename-btn";
        renameBtn.title = "Переименовать";
        renameBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.757l8.61-8.61z" stroke="currentColor" stroke-width="1.2"/></svg>`;
        renameBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            startInlineRename(tile, name, nameEl, countEl);
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "pl-row-action-btn pl-row-delete-btn";
        deleteBtn.title = "Удалить плейлист";
        deleteBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M2 4h12M5 4V2.5A.5.5 0 0 1 5.5 2h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.6A.5.5 0 0 0 4.3 14h7.4a.5.5 0 0 0 .5-.4L13 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
        deleteBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await handleDeletePlaylist(name, tile);
        });

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
    }

    tile.appendChild(actions);

    return tile;
}

async function handleSharePlaylist(name, data, iconSlot) {
    const code = encodePlaylistShare(name, data.videos || {});
    try {
        await navigator.clipboard.writeText(code);
        showToast(`✓ Код плейлиста «${name}» скопирован`);
        flashIconSuccess(iconSlot);
    } catch {
        prompt("Скопируйте код плейлиста вручную:", code);
    }
}

export async function sanitizeBrokenPlaylists() {
    const playlists = _getSelectorPlaylists();
    const broken = Object.keys(playlists).filter((name) => INVALID_CHARS.test(name));

    if (!broken.length) {
        showToast("✓ Сломанных плейлистов не найдено");
        return;
    }

    let fixed = 0;
    for (const oldName of broken) {
        const newName = oldName.replace(SANITIZE_CHARS, "_").trim();
        const finalName = playlists[newName] && newName !== oldName
            ? newName + "_" + Date.now()
            : newName;

        try {
            await _onRenamePlaylist(oldName, finalName);
            forgetLegacyIcon(oldName);
            if (_selectorSelected === oldName) {
                _selectorSelected = finalName;
                setPlaylistTriggerLabel(finalName);
            }
            fixed++;
        } catch (err) {
            console.error(`Не удалось исправить «${oldName}»:`, err);
        }
    }

    _selectorPlaylists = _getSelectorPlaylists();
    if (sortingOverlay.classList.contains("show") && _activeSortingTab === "playlists") {
        renderSelectorRows(sortingSearch.value.trim());
    }
    showToast(`✓ Исправлено плейлистов: ${fixed} из ${broken.length}`);
}

function startInlineRename(tile, oldName, nameEl, countEl) {
    tile.classList.add("pl-row--editing");

    const input = document.createElement("input");
    input.className = "pl-row-rename-input";
    input.value = oldName;
    input.maxLength = 80;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    const cancel = () => {
        if (committed) return;
        committed = true;
        input.replaceWith(nameEl);
        tile.classList.remove("pl-row--editing");
    };

    const commit = async () => {
        if (committed) return;
        committed = true;

        const newName = input.value.trim();
        input.replaceWith(nameEl);
        tile.classList.remove("pl-row--editing");

        if (!newName || newName === oldName) return;

        if (INVALID_CHARS.test(newName)) {
            showToast('⚠ Недопустимые символы: / \\ : * ? " < > |');
            return;
        }

        if (_selectorPlaylists[newName]) {
            showToast("⚠ Плейлист с таким именем уже существует");
            return;
        }

        try {
            await _onRenamePlaylist(oldName, newName);
            forgetLegacyIcon(oldName);

            if (_selectorSelected === oldName) {
                _selectorSelected = newName;
                setPlaylistTriggerLabel(newName);
            }

            nameEl.textContent = newName;
            showToast(`Плейлист переименован в «${newName}»`);
            renderSelectorRows(sortingSearch.value.trim());
        } catch (err) {
            showToast("⚠ Ошибка переименования");
            console.error("Rename error:", err);
        }
    };

    input.addEventListener("input", () => {
        input.classList.toggle("pl-row-rename-input--invalid", INVALID_CHARS.test(input.value));
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
    });
    input.addEventListener("blur", commit);
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
}

async function handleDeletePlaylist(name, tile) {
    const count = Object.keys(_selectorPlaylists[name]?.videos || {}).length;
    const msg = count > 0
        ? `Удалить плейлист «${name}»?\nВ нём ${count} видео. Видеофайлы останутся.`
        : `Удалить плейлист «${name}»?`;
    if (!confirm(msg)) return;

    try {
        await _onDeletePlaylist(name);
        delete _selectorPlaylists[name];
        tile.remove();

        if (_selectorSelected === name) {
            _selectorSelected = null;
            setPlaylistTriggerLabel("Playlist");
        }

        showToast(`Плейлист «${name}» удалён`);

        if (!Object.keys(_selectorPlaylists).length) {
            renderSelectorRows(sortingSearch.value.trim());
        }
    } catch (err) {
        showToast("⚠ Ошибка удаления");
        console.error("Delete error:", err);
    }
}

export function setPlaylistTriggerLabel(name) {
    playlistTriggerLabel.textContent = name;
    _selectorSelected = name;
}

// ─── Tags tab ──────────────────────────────────────────────────────────────

function renderTagFilterRows(query) {
    tagFilterListEl.innerHTML = "";
    const q = query.toLowerCase();
    const filtered = _allTagsCache.filter(({ tag }) => !q || tag.toLowerCase().includes(q));

    if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "pl-empty";
        empty.textContent = "Тегов не найдено";
        tagFilterListEl.appendChild(empty);
        return;
    }

    for (const { tag, count } of filtered) {
        tagFilterListEl.appendChild(buildTagTile(tag, count));
    }
}

function buildTagTile(tag, count) {
    const checked = _activeTags.includes(tag);

    const tile = document.createElement("div");
    tile.className = "pl-tile" + (checked ? " pl-tile--active" : "");

    const thumb = document.createElement("div");
    thumb.className = "pl-row-icon pl-tile-thumb pl-tag-thumb";
    thumb.textContent = "🏷";
    tile.appendChild(thumb);

    const text = document.createElement("div");
    text.className = "pl-tile-text";

    const nameEl = document.createElement("div");
    nameEl.className = "pl-tile-name";
    nameEl.textContent = tag;

    const countEl = document.createElement("div");
    countEl.className = "pl-tile-count";
    countEl.textContent = `${count} видео`;

    text.appendChild(nameEl);
    text.appendChild(countEl);
    tile.appendChild(text);

    const check = document.createElement("div");
    check.className = "pl-row-check";
    tile.appendChild(check);

    tile.addEventListener("click", (e) => {
        if (e.target.closest(".pl-row-actions")) return;
        const idx = _activeTags.indexOf(tag);
        if (idx === -1) _activeTags.push(tag);
        else _activeTags.splice(idx, 1);
        tile.classList.toggle("pl-tile--active");
        notifyTagFilterChange();
    });

    const actions = document.createElement("div");
    actions.className = "pl-row-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "pl-row-action-btn pl-row-rename-btn";
    renameBtn.title = "Переименовать тег";
    renameBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.757l8.61-8.61z" stroke="currentColor" stroke-width="1.2"/></svg>`;
    renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startInlineRenameTag(tile, tag, nameEl);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pl-row-action-btn pl-row-delete-btn";
    deleteBtn.title = "Удалить тег";
    deleteBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M2 4h12M5 4V2.5A.5.5 0 0 1 5.5 2h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.6A.5.5 0 0 0 4.3 14h7.4a.5.5 0 0 0 .5-.4L13 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
    deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await handleDeleteTag(tag, tile);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    tile.appendChild(actions);

    return tile;
}

async function handleDeleteTag(tag, tile) {
    if (!confirm(`Удалить тег «${tag}» из всех видео?`)) return;

    try {
        await _onDeleteTag(tag);
        _allTagsCache = _allTagsCache.filter((t) => t.tag !== tag);
        _activeTags = _activeTags.filter((t) => t !== tag);
        tile.remove();
        updateSortingSubtitle();
        showToast(`Тег «${tag}» удалён`);

        if (!_allTagsCache.length) renderTagFilterRows(sortingSearch.value.trim());
    } catch (err) {
        showToast("⚠ Ошибка удаления тега");
        console.error("Delete tag error:", err);
    }
}

async function handleDeleteAllTags() {
    if (!_allTagsCache.length) {
        showToast("Тегов нет");
        return;
    }

    const userInput = prompt(
        `Удалить ВСЕ теги (${_allTagsCache.length}) со всех видео? Это действие необратимо.\n\nВведите "Delete" для подтверждения:`
    );

    if (userInput === null) {
        // Пользователь нажал "Отмена"
        return;
    }

    if (userInput.trim() !== "Delete") {
        showToast("Удаление отменено: неверное подтверждение");
        return;
    }

    tagFilterDeleteAllBtn.disabled = true;
    try {
        await _onDeleteAllTags();
        _allTagsCache = [];
        _activeTags = [];
        renderTagFilterRows(sortingSearch.value.trim());
        updateSortingSubtitle();
        showToast("Все теги удалены");
    } catch (err) {
        showToast("⚠ Ошибка удаления тегов");
        console.error("Delete all tags error:", err);
    } finally {
        tagFilterDeleteAllBtn.disabled = false;
    }
}

function startInlineRenameTag(tile, oldTag, nameEl) {
    tile.classList.add("pl-row--editing");

    const input = document.createElement("input");
    input.className = "pl-row-rename-input";
    input.value = oldTag;
    input.maxLength = 40;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    const cancel = () => {
        if (committed) return;
        committed = true;
        input.replaceWith(nameEl);
        tile.classList.remove("pl-row--editing");
    };

    const commit = async () => {
        if (committed) return;
        committed = true;

        const newTag = input.value.trim();
        input.replaceWith(nameEl);
        tile.classList.remove("pl-row--editing");

        if (!newTag || newTag === oldTag) return;

        if (_allTagsCache.some(({ tag }) => tag === newTag)) {
            showToast("⚠ Тег с таким именем уже существует");
            return;
        }

        try {
            await _onRenameTag(oldTag, newTag);

            const entry = _allTagsCache.find(({ tag }) => tag === oldTag);
            if (entry) entry.tag = newTag;

            const idx = _activeTags.indexOf(oldTag);
            if (idx !== -1) _activeTags[idx] = newTag;

            nameEl.textContent = newTag;
            showToast(`Тег переименован в «${newTag}»`);
            renderTagFilterRows(sortingSearch.value.trim());
        } catch (err) {
            showToast("⚠ Ошибка переименования тега");
            console.error("Rename tag error:", err);
        }
    };

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
    });
    input.addEventListener("blur", commit);
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
}

function notifyTagFilterChange() {
    updateSortingSubtitle();
    _onTagFilterChange?.([..._activeTags], _tagMode);
}

// ─── isAnyPanelOpen — используется main.js для клика-паузы ────────────────

export function isAnyPanelOpen() {
    return (
        veOverlay.classList.contains("show") ||
        sortingOverlay.classList.contains("show") ||
        importOverlay.classList.contains("show")
    );
}

// ─── Seek Bar ─────────────────────────────────────────────────────────────

const seekBarTrack = document.getElementById("seekBarTrack");
const seekBarFill = document.getElementById("seekBarFill");
const seekBarThumb = document.getElementById("seekBarThumb");
const seekBarCurrent = document.getElementById("seekBarCurrent");
const seekBarDuration = document.getElementById("seekBarDuration");

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

export function initSeekBar(onSeek) {
    let dragging = false;

    const ratioFromEvent = (e) => {
        const rect = seekBarTrack.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };

    const setVisual = (ratio) => {
        seekBarFill.style.width = `${ratio * 100}%`;
        seekBarThumb.style.left = `${ratio * 100}%`;
    };

    const startDrag = (e) => {
        dragging = true;
        seekBarTrack.classList.add("seek-bar-track--dragging");
        drag(e);
        e.preventDefault();
    };

    const drag = (e) => {
        if (!dragging) return;
        const ratio = ratioFromEvent(e);
        setVisual(ratio);
        onSeek(ratio);
    };

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        seekBarTrack.classList.remove("seek-bar-track--dragging");
        onSeek(ratioFromEvent(e));
    };

    seekBarTrack.addEventListener("mousedown", startDrag);
    seekBarTrack.addEventListener("touchstart", startDrag, { passive: false });
    document.addEventListener("mousemove", drag);
    document.addEventListener("touchmove", drag, { passive: false });
    document.addEventListener("mouseup", endDrag);
    document.addEventListener("touchend", endDrag);

    return {
        isDragging: () => dragging,
        update(current, duration) {
            if (dragging) return;
            const ratio = duration > 0 ? current / duration : 0;
            setVisual(ratio);
            seekBarCurrent.textContent = formatTime(current);
            seekBarDuration.textContent = formatTime(duration);
        },
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// IMPORT PLAYLIST — загрузка стороннего плейлиста по коду
// ═════════════════════════════════════════════════════════════════════════════

const importOverlay = document.getElementById("importPlaylistOverlay");
const importPanel = document.getElementById("importPlaylistPanel");
const importClose = document.getElementById("importPlaylistClose");
const importInput = document.getElementById("importPlaylistInput");
const importParseBtn = document.getElementById("importPlaylistParseBtn");
const importStepInput = document.getElementById("importStepInput");
const importStepPreview = document.getElementById("importStepPreview");
const importStepProgress = document.getElementById("importStepProgress");
const importCountEl = document.getElementById("importPlaylistCount");
const importMergeNote = document.getElementById("importPlaylistMergeNote");
const importNameInput = document.getElementById("importPlaylistName");
const importBackBtn = document.getElementById("importPlaylistBackBtn");
const importConfirmBtn = document.getElementById("importPlaylistConfirmBtn");
const importProgressText = document.getElementById("importPlaylistProgressText");
const importPlaylistBtn = document.getElementById("importPlaylistBtn");

let _importPayload = null;
let _getPlaylistsForImport = null;
let _onImportConfirm = null;

export function initImportPlaylist({ getPlaylists, onImport }) {
    _getPlaylistsForImport = getPlaylists;
    _onImportConfirm = onImport;

    importPlaylistBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openImportOverlay();
    });

    importClose.addEventListener("click", closeImportOverlay);

    importParseBtn.addEventListener("click", () => {
        try {
            _importPayload = decodePlaylistShare(importInput.value);
        } catch (err) {
            showToast("⚠ " + err.message);
            return;
        }
        showPreviewStep();
    });

    importNameInput.addEventListener("input", updateMergeNote);
    importBackBtn.addEventListener("click", () => showStep("input"));

    importConfirmBtn.addEventListener("click", async () => {
        if (!_importPayload) return;
        const targetName = importNameInput.value.trim();
        if (!targetName) {
            showToast("⚠ Укажите название плейлиста");
            return;
        }

        showStep("progress");
        importProgressText.textContent = "Импорт…";

        try {
            const summary = await _onImportConfirm(targetName, _importPayload.items);
            closeImportOverlay();
            showToast(
                `✓ «${targetName}»: добавлено ${summary.addedLocally}, скачано ${summary.downloaded}` +
                (summary.failedDownloads ? `, ошибок ${summary.failedDownloads}` : "")
            );
        } catch (err) {
            showStep("preview");
            showToast("⚠ Ошибка импорта: " + err.message);
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.target.matches("input, textarea")) return;
        if (e.key === "Escape" && importOverlay.classList.contains("show")) closeImportOverlay();
    });

    document.addEventListener("click", (e) => {
        if (
            importOverlay.classList.contains("show") &&
            !importPanel.contains(e.target) &&
            !e.target.closest("#importPlaylistBtn")
        ) {
            closeImportOverlay();
        }
    });
}

function openImportOverlay() {
    _importPayload = null;
    importInput.value = "";
    showStep("input");
    importOverlay.classList.add("show");
    requestAnimationFrame(() => importInput.focus());
}

function closeImportOverlay() {
    importOverlay.classList.remove("show");
}

function showStep(step) {
    importStepInput.classList.toggle("hidden", step !== "input");
    importStepPreview.classList.toggle("hidden", step !== "preview");
    importStepProgress.classList.toggle("hidden", step !== "progress");
}

function showPreviewStep() {
    importCountEl.textContent = _importPayload.items.length;
    importNameInput.value = _importPayload.title || "Playlist";
    updateMergeNote();
    showStep("preview");
}

function updateMergeNote() {
    const name = importNameInput.value.trim();
    const playlists = _getPlaylistsForImport ? _getPlaylistsForImport() : {};
    const exists = name && playlists[name];
    importMergeNote.classList.toggle("hidden", !exists);
    if (exists) {
        const count = Object.keys(playlists[name].videos || {}).length;
        importMergeNote.textContent =
            `Плейлист «${name}» уже существует (${count} видео) — новые видео будут добавлены в него.`;
    }
}