// text-reveal.js — vanilla-порт компонента "LineMaskSplit" (Originkit).
// Проигрывает fade+slide+blur анимацию появления текста при каждом
// изменении значения. Без React/gsap/SplitText/ScrollTrigger.

const DEFAULT_STAGGER_MS = 18;

/**
 * Упрощённый reveal — весь текст/значение анимируется целиком
 * (без посимвольного сплита). Безопасен для <input> и элементов
 * с text-overflow: ellipsis.
 * @param {HTMLElement} el
 * @param {string|number} value
 */
export function revealSimple(el, value) {
    const isInput = "value" in el;
    const str = String(value);
    const current = isInput ? el.value : el.textContent;

    if (String(current) === str) return; // значение не изменилось — не переигрываем

    if (isInput) {
        el.value = str;
    } else {
        el.textContent = str;
    }

    el.classList.remove("tr-simple");
    void el.offsetWidth; // форсируем reflow, чтобы анимация переиграла даже при быстрой смене
    el.classList.add("tr-simple");
}

/**
 * Посимвольный reveal (как в оригинальном LineMaskSplit): каждый символ
 * в своей маске (overflow:hidden), появляется с задержкой (stagger).
 * ВНИМАНИЕ: ломает text-overflow:ellipsis у родителя — не использовать
 * на элементах, где текст может обрезаться многоточием.
 * @param {HTMLElement} el
 * @param {string} text
 * @param {{ stagger?: number }} [opts]
 */
export function revealChars(el, text, { stagger = DEFAULT_STAGGER_MS } = {}) {
    if (el.dataset.trText === text) return;
    el.dataset.trText = text;

    el.innerHTML = "";
    [...text].forEach((ch, i) => {
        const mask = document.createElement("span");
        mask.className = "tr-mask";

        const span = document.createElement("span");
        span.className = ch === " " ? "tr-char tr-space" : "tr-char";
        span.textContent = ch === " " ? "\u00A0" : ch;
        span.style.setProperty("--tr-i", i);
        if (stagger !== DEFAULT_STAGGER_MS) {
            span.style.animationDelay = `${i * stagger}ms`;
        }

        mask.appendChild(span);
        el.appendChild(mask);
    });
}