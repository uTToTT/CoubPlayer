using CoubPlayer.Storage;
using Newtonsoft.Json;

namespace CoubPlayer.Services
{
    /// <summary>Состояние восстановления для опроса из интерфейса.</summary>
    public class RestoreStatus
    {
        public bool running { get; set; }
        public bool stopping { get; set; }
        public int total { get; set; }
        public int done { get; set; }
        public int failed { get; set; }
        public int gone { get; set; }          // удалены с coub.com — вернуть нельзя
        public string? current { get; set; }
        public long? startedAt { get; set; }   // мс, для оценки оставшегося времени
        public bool finished { get; set; }
        public string? error { get; set; }
        public List<string> problems { get; set; } = new();
    }

    /// <summary>
    /// Итог прохода восстановления. Лежит в Data/restore-report.json.
    /// </summary>
    public class RestoreReport
    {
        public string finishedAt { get; set; } = "";
        public int total { get; set; }
        public int restored { get; set; }

        /// <summary>Ролики, которых больше нет у источника — вернуть нельзя.</summary>
        public List<string> gone { get; set; } = new();

        /// <summary>Не получилось по другой причине: id → текст ошибки. Стоит повторить.</summary>
        public Dictionary<string, string> failed { get; set; } = new();

        /// <summary>Проход прервали, часть роликов даже не пробовали.</summary>
        public bool stopped { get; set; }
    }

    /// <summary>
    /// Докачка роликов, которые числятся в библиотеке, но пропали с диска.
    ///
    /// Отдельно от обычной загрузки по двум причинам. Во-первых, плейлисты
    /// трогать не нужно: ролики в них уже записаны, не хватает только файлов,
    /// и любая правка playlists.json здесь была бы лишним риском. Во-вторых,
    /// таких роликов могут быть тысячи — нужен фоновый процесс с прогрессом
    /// и остановкой, а не один запрос на несколько часов.
    /// </summary>
    public class RestoreService
    {
        private readonly CoubDownloadService _downloads;
        private readonly CoubRepository _coubs;
        private readonly PlaylistRepository _playlists;

        private readonly object _lock = new();
        private RestoreStatus _status = new();
        private CancellationTokenSource? _cts;

        // Полные списки исходов. В _status.problems лежит только хвост для
        // показа в панели, а здесь — всё целиком: после прохода по тысячам
        // роликов важно знать поимённо, что именно не вернулось
        private readonly List<string> _gone = new();
        private readonly Dictionary<string, string> _failed = new();

        // Пауза между роликами: та же дисциплина, что и в обычной загрузке,
        // иначе coub.com начинает отвечать 403
        private const int DelayMs = 1500;
        private const int DelayJitterMs = 800;

        public RestoreService(
            CoubDownloadService downloads, CoubRepository coubs, PlaylistRepository playlists)
        {
            _downloads = downloads;
            _coubs = coubs;
            _playlists = playlists;
        }

        private static string CoubsDir => Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "Coubs");

        /// <summary>
        /// Ролики, которые есть в библиотеке и в плейлистах, но которых нет
        /// на диске. Признак наличия — video.mp4: без него ролик не играет,
        /// даже если аудио уцелело.
        /// </summary>
        public List<string> FindMissing()
        {
            var ids = new List<string>();
            var seen = new HashSet<string>();

            foreach (var id in _coubs.ReadIds())
            {
                if (string.IsNullOrEmpty(id) || !seen.Add(id)) continue;
                if (!HasVideo(id)) ids.Add(id);
            }

            // Плейлист может ссылаться на ролик, которого нет в библиотеке —
            // после потери данных такое вполне возможно, и его тоже надо вернуть
            foreach (var id in _playlists.ReadCoubIds())
            {
                if (!seen.Add(id)) continue;
                if (!HasVideo(id)) ids.Add(id);
            }

            return ids;
        }

        /// <summary>
        /// Пустой файл считается отсутствующим: так выглядит оборванная
        /// загрузка. Глубже не проверяем — чтение всех файлов на большой
        /// библиотеке заняло бы минуты, а ffmpeg в зависимостях у проекта нет.
        /// </summary>
        private static bool HasVideo(string id)
        {
            var info = new FileInfo(Path.Combine(CoubsDir, id, "video.mp4"));
            return info.Exists && info.Length > 0;
        }

        public RestoreStatus GetStatus()
        {
            lock (_lock) return Clone(_status);
        }

        /// <summary>Запускает докачку. Повторный вызов во время работы отклоняется.</summary>
        public RestoreStatus Start(List<string>? ids = null)
        {
            lock (_lock)
            {
                if (_status.running) return Clone(_status);

                var targets = ids ?? FindMissing();

                _gone.Clear();
                _failed.Clear();
                _cts = new CancellationTokenSource();
                _status = new RestoreStatus
                {
                    running = targets.Count > 0,
                    total = targets.Count,
                    startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    finished = targets.Count == 0,
                };

                if (targets.Count > 0)
                {
                    var token = _cts.Token;
                    _ = Task.Run(() => RunAsync(targets, token));
                }

                return Clone(_status);
            }
        }

        public RestoreStatus Stop()
        {
            lock (_lock)
            {
                if (_status.running)
                {
                    _status.stopping = true;
                    _cts?.Cancel();
                }
                return Clone(_status);
            }
        }

        private async Task RunAsync(List<string> ids, CancellationToken token)
        {
            var jitter = new Random();

            try
            {
                var needsDelay = false;

                foreach (var id in ids)
                {
                    if (token.IsCancellationRequested) break;

                    if (needsDelay)
                    {
                        try { await Task.Delay(DelayMs + jitter.Next(DelayJitterMs), token); }
                        catch (TaskCanceledException) { break; }
                    }

                    lock (_lock) _status.current = id;

                    // У загрузчика быстрый путь «файл на месте — качать не надо»,
                    // и пустышка от оборванной загрузки его обманывает. Убираем
                    // её заранее: терять в файле нулевого размера нечего
                    ClearEmptyFiles(id);

                    CoubDownloadResult result;
                    try
                    {
                        result = await _downloads.DownloadAsync(id);
                    }
                    catch (Exception ex)
                    {
                        lock (_lock)
                        {
                            _status.failed++;
                            _failed[id] = ex.Message;
                            AddProblem($"{id}: {ex.Message}");
                        }
                        needsDelay = true;
                        continue;
                    }

                    // Уже лежавшее на диске не качалось — паузу выдерживаем
                    // только после настоящей загрузки
                    needsDelay = result.Success && !result.AlreadyExisted;

                    lock (_lock)
                    {
                        if (result.Success)
                        {
                            _coubs.Upsert(result);
                            _status.done++;
                        }
                        else if (result.Gone)
                        {
                            _status.gone++;
                            _gone.Add(id);
                            AddProblem($"{id}: удалён с coub.com");
                        }
                        else
                        {
                            _status.failed++;
                            _failed[id] = result.Error ?? "неизвестная ошибка";
                            AddProblem($"{id}: {result.Error}");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                lock (_lock) _status.error = ex.Message;
            }
            finally
            {
                lock (_lock)
                {
                    _status.running = false;
                    _status.stopping = false;
                    _status.finished = true;
                    _status.current = null;
                }

                SaveReport();
            }
        }

        private static string ReportPath => Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "restore-report.json");

        /// <summary>
        /// Пишет итог прохода на диск. Нужен потому, что состояние в памяти
        /// живёт до перезапуска, а знать поимённо, какие ролики исчезли
        /// с coub.com, может понадобиться и через неделю.
        /// </summary>
        private void SaveReport()
        {
            try
            {
                RestoreReport report;
                lock (_lock)
                {
                    report = new RestoreReport
                    {
                        finishedAt = DateTime.UtcNow.ToString("o"),
                        total = _status.total,
                        restored = _status.done,
                        gone = new List<string>(_gone),
                        failed = new Dictionary<string, string>(_failed),
                        stopped = _status.done + _status.failed + _status.gone < _status.total,
                    };
                }

                var json = JsonConvert.SerializeObject(report, Formatting.Indented);
                var temp = ReportPath + ".tmp";
                File.WriteAllText(temp, json);

                if (File.Exists(ReportPath)) File.Replace(temp, ReportPath, null);
                else File.Move(temp, ReportPath);
            }
            catch (IOException)
            {
                // Отчёт — приятное дополнение, а не причина ронять восстановление
            }
        }

        /// <summary>Итог последнего прохода, если он был.</summary>
        public RestoreReport? ReadReport()
        {
            if (!File.Exists(ReportPath)) return null;
            try
            {
                return JsonConvert.DeserializeObject<RestoreReport>(File.ReadAllText(ReportPath));
            }
            catch (JsonException)
            {
                return null;
            }
        }

        /// <summary>
        /// Убирает файлы нулевого размера у одного ролика. Удаляем только то,
        /// в чём заведомо нет данных, и только внутри папки этого ролика.
        /// </summary>
        private static void ClearEmptyFiles(string id)
        {
            var folder = Path.Combine(CoubsDir, id);
            if (!Directory.Exists(folder)) return;

            foreach (var name in new[] { "video.mp4", "audio.mp3", "audio.m4a" })
            {
                var file = new FileInfo(Path.Combine(folder, name));
                if (!file.Exists || file.Length > 0) continue;

                try { file.Delete(); }
                catch (IOException) { /* занят — загрузчик всё равно перезапишет */ }
            }
        }

        /// <summary>В панель показываем только хвост — полный список лежит в отчёте.</summary>
        private void AddProblem(string text)
        {
            const int limit = 100;
            _status.problems.Add(text);
            if (_status.problems.Count > limit) _status.problems.RemoveAt(0);
        }

        private static RestoreStatus Clone(RestoreStatus s) => new()
        {
            running = s.running,
            stopping = s.stopping,
            total = s.total,
            done = s.done,
            failed = s.failed,
            gone = s.gone,
            current = s.current,
            startedAt = s.startedAt,
            finished = s.finished,
            error = s.error,
            problems = new List<string>(s.problems),
        };
    }
}
