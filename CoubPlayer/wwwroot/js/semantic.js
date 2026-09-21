// semantic.js — модель, которая переводит кадр и фразу в одни и те же числа.
//
// На этом стоит смысловой поиск: близость чисел означает близость по смыслу,
// и «кот прыгает» находит кота, даже если ролик называется «xd228».
//
// Почему считает браузер, а не сервер. Серверу для этого не хватает двух
// вещей сразу: он не умеет декодировать mp4 (ffmpeg в зависимостях нет и не
// планируется) и не умеет запускать модель. Браузер умеет и то, и другое,
// причём на видеокарте.
//
// А вот файлы модели хранит сервер: в сборку они не входят и докачиваются
// по надобности (см. ModelService). Кто смысловым поиском не пользуется,
// не платит за него ни байтом.
//
// Модель — SigLIP 2 base. Взята за многоязычность: русские запросы работают
// наравне с английскими, что для обычного CLIP неверно. Проверено на кадрах
// библиотеки — десять запросов из десяти (пять русских, пять английских)
// нашли нужный кадр первым.
//
// Две башни качаются порознь и только по надобности: зрительная нужна при
// построении индекса, текстовая — при поиске. Тот, кто только ищет, никогда
// не скачает зрительную, и наоборот.

// Всё берётся с нашего же сервера: и библиотека, и рантайм, и веса.
// Сервер приносит их один раз (см. ModelService) и дальше отдаёт как обычные
// файлы. Браузеру доверять хранение нельзя: текстовая башня в 270 МБ в его
// кэш попросту не попадает, а то, что попадает, он вправе вычистить.
//
// Отсюда же и главная выгода: после первой загрузки смысловой поиск работает
// вообще без интернета.
const ROOT = "/Data/models/";
const LIB = ROOT + "lib/transformers.min.js";

/** Папка модели внутри ROOT — её и открывает transformers.js. */
const LOCAL_MODEL = "siglip2";

/**
 * Чем считаются векторы. Метка уезжает в базу и с путём к файлам не связана:
 * веса те же самые, где бы они ни лежали, и переезд файлов не должен
 * обесценивать уже построенный индекс.
 */
export const MODEL_ID = "onnx-community/siglip2-base-patch16-256-ONNX";

// Сжатие весов. Проверено: на самых лёгких вариантах ранжирование уже верное,
// а качать втрое меньше. Зрительная башня q4f16 — 52 МБ, текстовая int8 — 270 МБ
const VISION_DTYPE = "q4f16";
const TEXT_DTYPE = "int8";

/** Длина вектора. Столько чисел на ролик и лежит в базе. */
export const DIM = 768;

/** Сколько токенов ждёт текстовая башня. Без явного числа токенизатор падает. */
const TEXT_TOKENS = 64;

/**
 * Чем построен индекс. Сжатие входит в метку намеренно: векторы, посчитанные
 * разными весами, слегка разные, и смешивать их в одной таблице — значит
 * получить поиск, который иногда врёт и никогда об этом не говорит.
 * Сменили сжатие — индекс надо строить заново.
 */
export const MODEL_TAG = `${MODEL_ID}@${VISION_DTYPE}`;

let _lib = null;
let _vision = null;
let _processor = null;
let _text = null;
let _tokenizer = null;

/** Загрузки, которые уже идут: второй вызов ждёт первую, а не качает заново. */
const _loading = { lib: null, vision: null, text: null };

function once(slot, make) {
    if (!_loading[slot]) {
        _loading[slot] = make().finally(() => { _loading[slot] = null; });
    }
    return _loading[slot];
}

async function library() {
    if (_lib) return _lib;
    return once("lib", async () => {
        let T;
        try {
            T = await import(/* @vite-ignore */ LIB);
        } catch {
            throw new Error(
                "Файлы модели не найдены. Откройте «Смысловой индекс» — " +
                "плеер скачает их один раз, дальше интернет не нужен."
            );
        }

        // Ходить в интернет запрещаем совсем: иначе отсутствующий файл
        // молча подтянулся бы с чужого сервера, и «работает без интернета»
        // оказалось бы неправдой ровно до первого отключения
        T.env.allowRemoteModels = false;
        T.env.allowLocalModels = true;
        T.env.localModelPath = ROOT;
        T.env.backends.onnx.wasm.wasmPaths = ROOT + "lib/ort/";

        // Второй копии в кэше браузера не надо: файлы и так лежат на диске
        // рядом с плеером, а лишние триста мегабайт браузер однажды всё
        // равно вычистит — и снова полезет за ними, теперь уже к нам
        T.env.useBrowserCache = false;

        _lib = T;
        return _lib;
    });
}

/** Готова ли башня — чтобы интерфейс знал, будет ли ожидание. */
export function isVisionReady() { return !!_vision; }
export function isTextReady() { return !!_text; }

/**
 * Зрительная башня: кадр → вектор. Нужна только при построении индекса.
 * @param {(p: {file: string, progress: number}) => void} [onProgress]
 */
export async function loadVision(onProgress) {
    if (_vision) return;
    await once("vision", async () => {
        const T = await library();
        _vision = await T.SiglipVisionModel.from_pretrained(LOCAL_MODEL, {
            dtype: VISION_DTYPE,
            device: "webgpu",
            progress_callback: (p) => report(p, onProgress),
        });
        _processor = await T.AutoProcessor.from_pretrained(LOCAL_MODEL);
    });
}

/**
 * Текстовая башня: фраза → вектор. Нужна только при поиске.
 * @param {(p: {file: string, progress: number}) => void} [onProgress]
 */
export async function loadText(onProgress) {
    if (_text) return;
    await once("text", async () => {
        const T = await library();
        _text = await T.SiglipTextModel.from_pretrained(LOCAL_MODEL, {
            dtype: TEXT_DTYPE,
            device: "webgpu",
            progress_callback: (p) => report(p, onProgress),
        });
        _tokenizer = await T.AutoTokenizer.from_pretrained(LOCAL_MODEL);
    });
}

function report(p, onProgress) {
    if (p?.status === "progress" && typeof p.progress === "number") {
        onProgress?.({ file: p.file, progress: p.progress });
    }
}

/**
 * Векторы кадров. На вход — canvas'ы с уже нарисованными кадрами.
 *
 * Именно canvas, а не ссылки на файлы: кадры снимаются с видео на лету, и
 * гонять их через диск и сеть ради этого незачем.
 *
 * Все кадры уезжают в модель одним вызовом: работы больше, а обращений к
 * видеокарте столько же. На замерах пять кадров пачкой — 60 мс против 112 мс
 * теми же пятью вызовами подряд, то есть впятеро больше кадров обходятся
 * меньше чем втрое дороже одного.
 *
 * @param {(HTMLCanvasElement|OffscreenCanvas)[]} canvases
 * @returns {Promise<Float32Array[]>} по вектору на кадр, в том же порядке
 */
export async function embedFrames(canvases) {
    if (!_vision) throw new Error("Зрительная башня ещё не загружена");
    if (!canvases.length) return [];

    const T = await library();
    const images = await Promise.all(canvases.map((c) => T.RawImage.fromCanvas(c)));
    const out = await _vision(await _processor(images));

    // Ответ приходит одним куском: вектора кадров лежат подряд. Проверяем,
    // что их ровно столько, сколько кадров, — молча разъехавшийся порядок
    // испортил бы индекс так, что заметили бы это очень нескоро
    const data = out.pooler_output.data;
    if (data.length !== canvases.length * DIM) {
        throw new Error(
            `Модель вернула ${data.length} чисел на ${canvases.length} кадров`
        );
    }

    return canvases.map((_, i) => new Float32Array(data.slice(i * DIM, (i + 1) * DIM)));
}

/**
 * Вектор фразы.
 * @param {string} phrase
 * @returns {Promise<Float32Array>}
 */
export async function embedText(phrase) {
    if (!_text) throw new Error("Текстовая башня ещё не загружена");
    const inputs = _tokenizer([phrase], {
        padding: "max_length",
        max_length: TEXT_TOKENS,
        truncation: true,
    });
    const out = await _text(inputs);
    return new Float32Array(out.pooler_output.data);
}

/**
 * Есть ли у браузера видеокарта для расчётов.
 *
 * Без WebGPU transformers.js уедет на процессор — считать будет, но заметно
 * дольше, и об этом лучше предупредить заранее, чем оставить человека
 * с зависшей на час индексацией.
 */
export async function hasWebGPU() {
    if (!navigator.gpu) return false;
    try {
        return !!(await navigator.gpu.requestAdapter());
    } catch {
        return false;
    }
}
