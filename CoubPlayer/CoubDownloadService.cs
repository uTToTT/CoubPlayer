using Newtonsoft.Json.Linq;

namespace CoubPlayer.Services
{
    public class CoubDownloadResult
    {
        public string Id { get; set; } = "";
        public string? Title { get; set; }
        public bool Success { get; set; }
        public string? Error { get; set; }

        // Относительные веб-пути к скачанным файлам (для записи в coub_list.json).
        // Заполняются и при AlreadyExisted — контроллеру нужно знать пути, чтобы
        // добавить/актуализировать запись в coub_list.json в любом случае.
        public string? Video { get; set; }
        public string? Audio { get; set; }

        // true, если файлы уже лежали на диске — скачивание пропущено,
        // но ролик всё равно нужно добавить в плейлист (и в coub_list.json, если его там нет)
        public bool AlreadyExisted { get; set; }
    }

    /// <summary>
    /// Скачивает видео/аудио потоки coub-роликов напрямую через публичный API Coub,
    /// без внешних зависимостей (python/ffmpeg). Видео и аудио сохраняются как
    /// отдельные файлы — так же, как их использует существующий плеер
    /// (Player.play выставляет activeVideo.src и audio.src раздельно).
    /// Раскладка на диске совпадает с той, что использовал старый Python-загрузчик:
    /// wwwroot/Data/Coubs/{id}/video.mp4 + audio.{mp3|m4a}
    /// </summary>
    public class CoubDownloadService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly string _dataDir = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "Coubs");

        public CoubDownloadService(IHttpClientFactory httpClientFactory)
        {
            _httpClientFactory = httpClientFactory;
        }

        /// <summary>
        /// Достаёт id ролика из ссылки вида https://coub.com/view/2z1u9p.
        /// Также принимает голый id без слешей.
        /// </summary>
        public static string? ExtractCoubId(string urlOrId)
        {
            var s = urlOrId?.Trim().TrimEnd('/');
            if (string.IsNullOrEmpty(s)) return null;

            const string marker = "/view/";
            var idx = s.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (idx >= 0)
            {
                var tail = s[(idx + marker.Length)..];
                tail = tail.Split('?')[0].Split('#')[0].Split('/')[0];
                return string.IsNullOrEmpty(tail) ? null : tail;
            }

            // Похоже на голый id (без схемы, без слешей и точек)
            if (!s.Contains('/') && !s.Contains('.') && !s.Contains(':'))
                return s;

            return null;
        }

        public async Task<CoubDownloadResult> DownloadAsync(string urlOrId)
        {
            var id = ExtractCoubId(urlOrId);
            if (string.IsNullOrEmpty(id))
            {
                return new CoubDownloadResult
                {
                    Id = urlOrId,
                    Success = false,
                    Error = "Не удалось распознать ссылку/id"
                };
            }

            var folder = Path.Combine(_dataDir, id);
            var videoPath = Path.Combine(folder, "video.mp4");

            var client = _httpClientFactory.CreateClient("Coub");
            // Один UA на весь ролик (метаданные + видео + аудио) —
            // ротируется только между разными роликами, а не внутри одного
            var userAgent = CoubUserAgents.GetRandomAgent();

            try
            {
                var json = await GetStringAsync(client, $"https://coub.com/api/v2/coubs/{id}", userAgent);
                var data = JObject.Parse(json);
                var title = data["title"]?.ToString() ?? id;

                if (File.Exists(videoPath))
                {
                    // Уже скачано ранее (например, в другой плейлист) — файлы трогать не нужно,
                    // но пути для coub_list.json всё равно нужно вернуть
                    string? existingAudio = null;
                    var mp3Path = Path.Combine(folder, "audio.mp3");
                    var m4aPath = Path.Combine(folder, "audio.m4a");
                    if (File.Exists(mp3Path)) existingAudio = $"/Data/Coubs/{id}/audio.mp3";
                    else if (File.Exists(m4aPath)) existingAudio = $"/Data/Coubs/{id}/audio.m4a";

                    return new CoubDownloadResult
                    {
                        Id = id,
                        Title = title,
                        Success = true,
                        AlreadyExisted = true,
                        Video = $"/Data/Coubs/{id}/video.mp4",
                        Audio = existingAudio
                    };
                }

                var videoUrl = PickBestVideo(data);
                if (videoUrl == null)
                {
                    return new CoubDownloadResult
                    {
                        Id = id,
                        Title = title,
                        Success = false,
                        Error = "Видео-поток недоступен (coub мог быть удалён)"
                    };
                }

                var (audioUrl, audioExt) = PickBestAudio(data);

                Directory.CreateDirectory(folder);

                await DownloadFileAsync(client, videoUrl, videoPath, userAgent);

                string? audioRel = null;
                if (audioUrl != null)
                {
                    var audioPath = Path.Combine(folder, $"audio.{audioExt}");
                    await DownloadFileAsync(client, audioUrl, audioPath, userAgent);
                    audioRel = $"/Data/Coubs/{id}/audio.{audioExt}";
                }

                return new CoubDownloadResult
                {
                    Id = id,
                    Title = title,
                    Success = true,
                    Video = $"/Data/Coubs/{id}/video.mp4",
                    Audio = audioRel
                };
            }
            catch (Exception ex)
            {
                // Подчищаем недокачанную папку, чтобы не путать с валидным кэшем
                try
                {
                    if (Directory.Exists(folder) && !File.Exists(videoPath))
                        Directory.Delete(folder, recursive: true);
                }
                catch { /* не критично */ }

                return new CoubDownloadResult { Id = id, Success = false, Error = ex.Message };
            }
        }

        // ─── Выбор потоков (порт stream_lists() из coub_v2.py) ────────────────

        private static string? PickBestVideo(JObject data)
        {
            // html5.video: med (~360p) < high (~720p) < higher (~900p)
            foreach (var quality in new[] { "higher", "high", "med" })
            {
                var version = data.SelectToken($"file_versions.html5.video.{quality}");
                var url = version?["url"]?.ToString();
                var size = version?["size"]?.Value<long?>();
                if (!string.IsNullOrEmpty(url) && size is > 0)
                    return url;
            }
            return null;
        }

        private static (string? url, string ext) PickBestAudio(JObject data)
        {
            // Порядок предпочтения как в coub_v2.py по умолчанию (opts.aac == 1):
            // html5 med -> mobile 0 (обычно AAC) -> html5 high
            var htmlMed = data.SelectToken("file_versions.html5.audio.med");
            var htmlMedUrl = htmlMed?["url"]?.ToString();
            if (!string.IsNullOrEmpty(htmlMedUrl) && htmlMed?["size"]?.Value<long?>() is > 0)
                return (htmlMedUrl, "mp3");

            // mobile.audio — объект с ключами "0"/"1", а не массив
            var mobileAudio = data.SelectToken("file_versions.mobile.audio.0")?.ToString();
            if (!string.IsNullOrEmpty(mobileAudio))
                return (mobileAudio, mobileAudio.Contains(".m4a") ? "m4a" : "mp3");

            var htmlHigh = data.SelectToken("file_versions.html5.audio.high");
            var htmlHighUrl = htmlHigh?["url"]?.ToString();
            if (!string.IsNullOrEmpty(htmlHighUrl) && htmlHigh?["size"]?.Value<long?>() is > 0)
                return (htmlHighUrl, "mp3");

            return (null, "mp3");
        }

        // ─── HTTP-хелперы ──────────────────────────────────────────────────────

        private static async Task<string> GetStringAsync(HttpClient client, string url, string userAgent)
        {
            using var res = await HttpRetryHelper.SendWithRetryAsync(client, () =>
            {
                var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.UserAgent.ParseAdd(userAgent);
                return req;
            });
            res.EnsureSuccessStatusCode();
            return await res.Content.ReadAsStringAsync();
        }

        private static async Task DownloadFileAsync(
            HttpClient client, string url, string destPath, string userAgent)
        {
            using var res = await HttpRetryHelper.SendWithRetryAsync(client, () =>
            {
                var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.UserAgent.ParseAdd(userAgent);
                return req;
            });
            res.EnsureSuccessStatusCode();
            await using var fs = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None);
            await res.Content.CopyToAsync(fs);
        }
    }
}