using System.Diagnostics;

namespace CoubPlayer.Services
{
    /// <summary>
    /// Скачивает то, чем считается смысловой поиск: саму модель, токенизатор
    /// и рантайм, на котором всё это крутится в браузере.
    ///
    /// Почему файлы лежат у нас, а не берутся браузером из интернета каждый раз.
    /// Браузер кладёт скачанное в Cache Storage, и это ненадёжно сразу с двух
    /// сторон: проверено, что текстовая башня в 270 МБ туда просто не попадает,
    /// а то, что попадает, браузер вправе вычистить под нехватку места. Триста
    /// мегабайт, уехавшие посреди работы, — ровно то, чего не хочется.
    ///
    /// Лежат они рядом с библиотекой, а не внутри сборки: это не часть плеера,
    /// а то, что он докачивает по надобности. Кто смысловым поиском не
    /// пользуется, не платит за него ни байтом.
    ///
    /// Побочная выгода: после первой загрузки смысловой поиск работает вообще
    /// без интернета — что для портативного плеера и правильно.
    /// </summary>
    public class ModelService
    {
        /// <summary>
        /// Один файл, который надо принести. Размер указан не для красоты:
        /// по нему видно, докачался файл или оборвался на середине.
        /// </summary>
        public record Asset(string Url, string Path, long Size, string Note);

        private const string HF =
            "https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/main/";
        // Адрес пакета без пути к файлу — не небрежность, а необходимость:
        // так CDN отдаёт сборку, внутри которой уже лежит рантайм. Файл
        // из dist/ выглядит тем же самым, но тянет onnxruntime-web отдельным
        // импортом без пути, и в браузере без сборщика просто не запускается
        private const string TJS =
            "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
        private const string ORT =
            "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";

        /// <summary>
        /// Что именно нужно. Версии закреплены намеренно: обновление
        /// transformers.js тянет за собой свою версию рантайма, и разъехаться
        /// им посреди индексации нельзя.
        /// </summary>
        public static readonly Asset[] Manifest =
        {
            new(TJS, "lib/transformers.min.js", 581_935, "библиотека"),
            new($"{ORT}ort-wasm-simd-threaded.asyncify.mjs", "lib/ort/ort-wasm-simd-threaded.asyncify.mjs", 53_078, "рантайм"),
            new($"{ORT}ort-wasm-simd-threaded.asyncify.wasm", "lib/ort/ort-wasm-simd-threaded.asyncify.wasm", 26_861_741, "рантайм"),

            new($"{HF}config.json", "siglip2/config.json", 0, "настройки модели"),
            new($"{HF}preprocessor_config.json", "siglip2/preprocessor_config.json", 0, "настройки модели"),
            new($"{HF}tokenizer_config.json", "siglip2/tokenizer_config.json", 0, "настройки модели"),
            new($"{HF}tokenizer.json", "siglip2/tokenizer.json", 34_363_047, "словарь"),

            new($"{HF}onnx/vision_model_q4f16.onnx", "siglip2/onnx/vision_model_q4f16.onnx", 54_745_735, "разбор кадров"),
            new($"{HF}onnx/text_model_int8.onnx", "siglip2/onnx/text_model_int8.onnx", 283_449_249, "разбор запросов"),
        };

        private readonly IHttpClientFactory _http;
        private readonly string _root;
        private readonly object _lock = new();

        private State _state = new();
        private CancellationTokenSource? _cancel;

        public ModelService(IHttpClientFactory http)
        {
            _http = http;
            _root = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "Data", "models");
        }

        public class State
        {
            public bool Running { get; set; }
            public bool Finished { get; set; }
            public bool Stopped { get; set; }
            public string? Current { get; set; }
            public long DoneBytes { get; set; }
            public long TotalBytes { get; set; }
            public string? Error { get; set; }
        }

        // ─── Что уже есть ───────────────────────────────────────────────────

        public object GetStatus()
        {
            var files = Manifest.Select(a => new
            {
                path = a.Path,
                note = a.Note,
                ready = IsReady(a),
            }).ToList();

            return new
            {
                complete = files.All(f => f.ready),
                ready = files.Count(f => f.ready),
                total = files.Count,
                // Сколько качать, если начинать сейчас
                bytes = Manifest.Where(a => !IsReady(a)).Sum(a => a.Size),
                allBytes = Manifest.Sum(a => a.Size),
                files,
                progress = Snapshot(),
            };
        }

        /// <summary>
        /// Файл на месте и целиком. Размер сверяется там, где он известен:
        /// оборванная загрузка оставляет файл короче, и без проверки он
        /// выглядел бы готовым — а ломалось бы потом в браузере и непонятно где.
        /// </summary>
        private bool IsReady(Asset asset)
        {
            var path = Path.Combine(_root, asset.Path.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(path)) return false;
            if (asset.Size == 0) return new FileInfo(path).Length > 0;

            // Допуск в пару процентов: размеры в списке записаны с наблюдения,
            // а не из заголовка ответа, и точное совпадение требовать рискованно
            var length = new FileInfo(path).Length;
            return length >= asset.Size * 0.97;
        }

        // ─── Загрузка ───────────────────────────────────────────────────────

        public object Start()
        {
            lock (_lock)
            {
                if (_state.Running) return Snapshot();

                var missing = Manifest.Where(a => !IsReady(a)).ToList();
                _state = new State
                {
                    Running = missing.Count > 0,
                    Finished = missing.Count == 0,
                    TotalBytes = missing.Sum(a => a.Size),
                };

                if (missing.Count == 0) return Snapshot();

                _cancel = new CancellationTokenSource();
                _ = Task.Run(() => Run(missing, _cancel.Token));
                return Snapshot();
            }
        }

        public object Stop()
        {
            lock (_lock)
            {
                _cancel?.Cancel();
                _state.Stopped = true;
                return Snapshot();
            }
        }

        public object Progress() => Snapshot();

        private object Snapshot()
        {
            lock (_lock)
            {
                return new
                {
                    running = _state.Running,
                    finished = _state.Finished,
                    stopped = _state.Stopped,
                    current = _state.Current,
                    doneBytes = _state.DoneBytes,
                    totalBytes = _state.TotalBytes,
                    error = _state.Error,
                };
            }
        }

        private async Task Run(List<Asset> assets, CancellationToken token)
        {
            var watch = Stopwatch.StartNew();
            ConsoleLog.Section("МОДЕЛЬ СМЫСЛОВОГО ПОИСКА");
            ConsoleLog.Info($"  файлов: {assets.Count}, примерно {assets.Sum(a => a.Size) / 1024 / 1024} МБ");

            try
            {
                var client = _http.CreateClient();
                // Модель — сотни мегабайт, а клиент по умолчанию сдаётся через
                // полторы минуты. Ограничение здесь — только отмена вручную
                client.Timeout = Timeout.InfiniteTimeSpan;

                foreach (var asset in assets)
                {
                    token.ThrowIfCancellationRequested();

                    lock (_lock) _state.Current = asset.Note;
                    await Download(client, asset, token);
                    ConsoleLog.Muted($"  готово: {asset.Path}");
                }

                lock (_lock) { _state.Running = false; _state.Finished = true; _state.Current = null; }
                ConsoleLog.Success($"  модель на месте, заняло {watch.Elapsed.TotalSeconds:F0} с");
            }
            catch (OperationCanceledException)
            {
                lock (_lock) { _state.Running = false; _state.Finished = true; _state.Stopped = true; }
                ConsoleLog.Muted("  загрузка остановлена");
            }
            catch (Exception ex)
            {
                lock (_lock)
                {
                    _state.Running = false;
                    _state.Finished = true;
                    _state.Error = ex.Message;
                }
                ConsoleLog.Error("  не удалось: " + ex.Message);
            }
            finally
            {
                ConsoleLog.Divider();
            }
        }

        /// <summary>
        /// Через временный файл: оборванная загрузка иначе оставила бы
        /// обрезанный файл на месте настоящего, и дальше всё ломалось бы
        /// в браузере, где причину уже не видно.
        /// </summary>
        private async Task Download(HttpClient client, Asset asset, CancellationToken token)
        {
            var path = Path.Combine(_root, asset.Path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);

            var temp = path + ".part";

            using var response = await client.GetAsync(
                asset.Url, HttpCompletionOption.ResponseHeadersRead, token);
            response.EnsureSuccessStatusCode();

            await using (var source = await response.Content.ReadAsStreamAsync(token))
            await using (var target = File.Create(temp))
            {
                var buffer = new byte[1 << 16];
                int read;
                while ((read = await source.ReadAsync(buffer, token)) > 0)
                {
                    await target.WriteAsync(buffer.AsMemory(0, read), token);
                    lock (_lock) _state.DoneBytes += read;
                }
            }

            File.Move(temp, path, overwrite: true);
        }
    }
}
