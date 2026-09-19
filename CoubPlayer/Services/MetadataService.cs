using CoubPlayer.Storage;

namespace CoubPlayer.Services
{
    /// <summary>Состояние дозагрузки метаданных для опроса из интерфейса.</summary>
    public class MetadataStatus
    {
        public bool running { get; set; }
        public bool stopping { get; set; }
        public int total { get; set; }
        public int done { get; set; }
        public int gone { get; set; }          // удалены с coub.com — сведений уже не будет
        public int failed { get; set; }
        public string? current { get; set; }
        public long? startedAt { get; set; }   // мс, для оценки оставшегося времени
        public bool finished { get; set; }
        public string? error { get; set; }

        /// <summary>Сколько роликов в библиотеке и у скольких сведения уже есть.</summary>
        public int libraryTotal { get; set; }
        public int libraryFetched { get; set; }
    }

    /// <summary>
    /// Дозагрузка сведений о роликах от Coub: канал, длительность, размер
    /// кадра, nsfw и теги самого сайта.
    ///
    /// Зачем. В файлах ролика этого нет, а подсказать «куда положить и что
    /// повесить» можно только по ним. Восемь с половиной тысяч роликов —
    /// это часы обхода с паузами, поэтому задача фоновая, с прогрессом
    /// и остановкой, а не один запрос.
    ///
    /// Проход можно прерывать и повторять сколько угодно: каждый ролик
    /// отмечается сразу после ответа, и следующий запуск берёт только тех,
    /// о ком ещё не спрашивали.
    /// </summary>
    public class MetadataService
    {
        private readonly CoubDownloadService _downloads;
        private readonly CoubRepository _coubs;

        private readonly object _lock = new();
        private MetadataStatus _status = new();
        private CancellationTokenSource? _cts;

        // Та же дисциплина, что у загрузки файлов: без пауз coub.com
        // начинает отвечать 403
        private const int DelayMs = 1500;
        private const int DelayJitterMs = 800;

        public MetadataService(CoubDownloadService downloads, CoubRepository coubs)
        {
            _downloads = downloads;
            _coubs = coubs;
        }

        public MetadataStatus GetStatus()
        {
            lock (_lock)
            {
                var status = Clone(_status);
                var (total, fetched) = _coubs.MetadataStats();
                status.libraryTotal = total;
                status.libraryFetched = fetched;
                return status;
            }
        }

        /// <summary>Сколько роликов ещё без сведений.</summary>
        public int CountPending() => _coubs.FindWithoutMetadata().Count;

        public MetadataStatus Start()
        {
            lock (_lock)
            {
                if (_status.running) return GetStatus();

                var targets = _coubs.FindWithoutMetadata();

                _cts = new CancellationTokenSource();
                _status = new MetadataStatus
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

                return GetStatus();
            }
        }

        public MetadataStatus Stop()
        {
            lock (_lock)
            {
                if (_status.running)
                {
                    _status.stopping = true;
                    _cts?.Cancel();
                }
            }
            return GetStatus();
        }

        private async Task RunAsync(List<string> ids, CancellationToken token)
        {
            var jitter = new Random();

            ConsoleLog.Section($"МЕТАДАННЫЕ: {ids.Count} роликов");

            try
            {
                var first = true;

                foreach (var id in ids)
                {
                    if (token.IsCancellationRequested) break;

                    if (!first)
                    {
                        try { await Task.Delay(DelayMs + jitter.Next(DelayJitterMs), token); }
                        catch (TaskCanceledException) { break; }
                    }
                    first = false;

                    lock (_lock) _status.current = id;

                    var meta = await _downloads.FetchMetadataAsync(id);

                    if (meta.Gone)
                    {
                        // Сведений уже не будет — отмечаем, чтобы не спрашивать
                        // о нём при каждом следующем проходе
                        _coubs.MarkMetadataChecked(id);
                        lock (_lock) _status.gone++;
                        continue;
                    }

                    if (meta.Error != null)
                    {
                        // Сеть или 403 — причина временная, отметку не ставим:
                        // следующий проход возьмёт этот ролик снова
                        lock (_lock) _status.failed++;
                        continue;
                    }

                    _coubs.SaveMetadata(meta);
                    lock (_lock) _status.done++;
                }
            }
            catch (Exception ex)
            {
                lock (_lock) _status.error = ex.Message;
                ConsoleLog.Error($"  метаданные: {ex.Message}");
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

                var s = GetStatus();
                ConsoleLog.Success(
                    $"  готово: сведения {s.done}, удалено с сайта {s.gone}, не вышло {s.failed}");
                ConsoleLog.Divider();
            }
        }

        private static MetadataStatus Clone(MetadataStatus s) => new()
        {
            running = s.running,
            stopping = s.stopping,
            total = s.total,
            done = s.done,
            gone = s.gone,
            failed = s.failed,
            current = s.current,
            startedAt = s.startedAt,
            finished = s.finished,
            error = s.error,
        };
    }
}
