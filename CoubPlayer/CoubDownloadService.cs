using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace CoubPlayer.Services
{
    /// <summary>
    /// Что нужно скачать для одного ролика.
    ///
    /// Нужен там, где файлы тянет не сервер, а расширение в браузере. Правила
    /// выбора качества при этом остаются здесь, в единственном экземпляре:
    /// расширение только исполняет ответ, а не решает само.
    /// </summary>
    public class CoubDownloadPlan
    {
        public string Id { get; set; } = "";
        public string? Title { get; set; }

        /// <summary>Файлы уже на диске — качать нечего, ролик надо только добавить в плейлист.</summary>
        public bool AlreadyExists { get; set; }

        /// <summary>Нужны метаданные: без них выбирать потоки не из чего.</summary>
        public bool NeedsMeta { get; set; }

        /// <summary>В метаданных нет видео-потока — ролика у источника больше нет.</summary>
        public bool Gone { get; set; }

        public string? Video { get; set; }
        public string? Audio { get; set; }
        public string AudioExt { get; set; } = "mp3";
    }

    /// <summary>
    /// Сведения о ролике от Coub — то, чего нет в самих файлах.
    ///
    /// Нужны ради подсказки «куда положить и что повесить»: угадывать её
    /// можно только по тегам и каналу, а их знает лишь сайт.
    /// </summary>
    public class CoubMetadata
    {
        public string Id { get; set; } = "";
        public string? Title { get; set; }
        public long? ChannelId { get; set; }
        public string? ChannelTitle { get; set; }
        public double? Duration { get; set; }
        public int? Width { get; set; }
        public int? Height { get; set; }
        public bool? Nsfw { get; set; }

        /// <summary>Теги самого Coub. К тегам пользователя отношения не имеют.</summary>
        public List<string> Tags { get; set; } = new();

        /// <summary>Ролика больше нет у источника — спрашивать о нём незачем.</summary>
        public bool Gone { get; set; }

        public string? Error { get; set; }
    }

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

        // true, если ролика больше нет у источника: удалён, скрыт или заблокирован.
        // Отличается от обычной неудачи тем, что повторять попытки бесполезно —
        // ни сейчас, ни завтра. Разбирать текст ошибки для этого не надо.
        public bool Gone { get; set; }

        // Сведения о ролике, если при загрузке пришлось спрашивать о нём Coub.
        // Тот же ответ API, из которого берутся ссылки на потоки: раз он уже
        // в руках, выбрасывать его — значит потом идти за ним второй раз.
        // null на быстром пути «файлы уже на диске»: там запроса не было.
        public CoubMetadata? Metadata { get; set; }
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

        /// <summary>
        /// Годится ли id как имя папки. Проверка обязательна для всего, что
        /// приходит снаружи: id идёт прямо в путь, и «..» в нём увело бы запись
        /// за пределы библиотеки.
        /// </summary>
        public static bool IsSafeId(string? id) =>
            !string.IsNullOrEmpty(id) && Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,64}$");

        // ─── Загрузка чужими руками ────────────────────────────────────────────
        // Когда до coub.com не достаёт сам сервер (блокировка провайдера, VPN
        // только в браузере), файлы приносит расширение. Сервер в этой паре
        // решает, что качать, и раскладывает принесённое по местам.

        /// <summary>
        /// Что нужно скачать для ролика. Без <paramref name="meta"/> отвечает
        /// только на дешёвый вопрос «а есть ли уже файлы» — чтобы не тратить
        /// трафик VPN на метаданные того, что и так лежит на диске.
        /// </summary>
        public CoubDownloadPlan Plan(string id, JObject? meta)
        {
            var plan = new CoubDownloadPlan { Id = id };

            // Пустой файл — след оборванной загрузки, а не скачанный ролик
            var video = new FileInfo(Path.Combine(_dataDir, id, "video.mp4"));
            if (video.Exists && video.Length > 0)
            {
                plan.AlreadyExists = true;
                return plan;
            }

            if (meta == null)
            {
                plan.NeedsMeta = true;
                return plan;
            }

            plan.Title = meta["title"]?.ToString() ?? id;

            var videoUrl = PickBestVideo(meta);
            if (videoUrl == null)
            {
                plan.Gone = true;
                return plan;
            }

            var (audioUrl, audioExt) = PickBestAudio(meta);
            plan.Video = videoUrl;
            plan.Audio = audioUrl;
            plan.AudioExt = audioExt;
            return plan;
        }

        /// <summary>
        /// Кладёт на диск файлы, скачанные не сервером, а расширением.
        /// Результат намеренно той же формы, что у <see cref="DownloadAsync"/>:
        /// дальше по пути — coub_list.json и плейлист — разницы быть не должно.
        /// </summary>
        public async Task<CoubDownloadResult> SaveUploadAsync(
            string id, string? title, Stream video, Stream? audio, string audioExt)
        {
            if (!IsSafeId(id)) throw new ArgumentException("Некорректный id", nameof(id));

            // Расширение присылает расширение файла строкой — в путь она попасть
            // не должна ничем, кроме двух известных значений
            var ext = audioExt == "m4a" ? "m4a" : "mp3";

            var folder = Path.Combine(_dataDir, id);
            var videoPath = Path.Combine(folder, "video.mp4");
            var audioPath = audio == null ? null : Path.Combine(folder, $"audio.{ext}");

            Directory.CreateDirectory(folder);

            try
            {
                // Пишем рядом и переносим только когда всё целиком дошло:
                // оборванная заливка иначе оставила бы обрезанный video.mp4,
                // неотличимый от нормально скачанного ролика
                await WriteToFileAsync(video, videoPath + ".part");
                if (audio != null) await WriteToFileAsync(audio, audioPath + ".part");

                File.Move(videoPath + ".part", videoPath, overwrite: true);
                if (audioPath != null) File.Move(audioPath + ".part", audioPath, overwrite: true);
            }
            catch
            {
                CleanupPartials(folder);
                throw;
            }

            return new CoubDownloadResult
            {
                Id = id,
                Title = string.IsNullOrWhiteSpace(title) ? id : title,
                Success = true,
                Video = $"/Data/Coubs/{id}/video.mp4",
                Audio = audioPath == null ? null : $"/Data/Coubs/{id}/audio.{ext}",
            };
        }

        private static async Task WriteToFileAsync(Stream source, string destPath)
        {
            await using var fs = new FileStream(
                destPath, FileMode.Create, FileAccess.Write, FileShare.None);
            await source.CopyToAsync(fs);
        }

        /// <summary>
        /// Убирает недописанные куски. Папку целиком не трогаем: в ней может
        /// лежать раньше скачанное аудио, а удалять чужое по дороге незачем.
        /// </summary>
        private static void CleanupPartials(string folder)
        {
            try
            {
                foreach (var file in Directory.EnumerateFiles(folder, "*.part"))
                    File.Delete(file);

                if (!Directory.EnumerateFileSystemEntries(folder).Any())
                    Directory.Delete(folder);
            }
            catch (IOException) { /* не критично: следующая попытка перезапишет */ }
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

            // Быстрый путь: если ролик уже скачан — не делаем сетевой запрос к API вообще.
            // Раньше метаданные запрашивались всегда, даже для уже скачанных роликов,
            // просто ради title — это и было узким местом (~10 роликов/сек на сетевую задержку).
            if (File.Exists(videoPath))
            {
                string? existingAudio = null;
                var mp3Path = Path.Combine(folder, "audio.mp3");
                var m4aPath = Path.Combine(folder, "audio.m4a");
                if (File.Exists(mp3Path)) existingAudio = $"/Data/Coubs/{id}/audio.mp3";
                else if (File.Exists(m4aPath)) existingAudio = $"/Data/Coubs/{id}/audio.m4a";

                return new CoubDownloadResult
                {
                    Id = id,
                    Title = null, // заголовок не запрашивали — контроллер сам подставит id как фолбэк
                    Success = true,
                    AlreadyExisted = true,
                    Video = $"/Data/Coubs/{id}/video.mp4",
                    Audio = existingAudio
                };
            }

            var client = _httpClientFactory.CreateClient("Coub");
            var userAgent = CoubUserAgents.GetRandomAgent();

            try
            {
                var json = await GetStringAsync(client, $"https://coub.com/api/v2/coubs/{id}", userAgent);
                var data = JObject.Parse(json);
                var title = data["title"]?.ToString() ?? id;

                // Защита от гонки: файл мог появиться между проверкой выше и этим запросом
                // (например, при параллельных вызовах DownloadAsync для одного id)
                if (File.Exists(videoPath))
                {
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
                        Audio = existingAudio,
                        Metadata = ParseMetadata(id, data),
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
                        Gone = true,
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
                    Audio = audioRel,
                    Metadata = ParseMetadata(id, data),
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

                // 404 и 410 от API означают, что ролика у источника больше нет:
                // возвращаться к нему незачем, в отличие от таймаута или 403
                var gone = ex is HttpRequestException http &&
                           http.StatusCode is System.Net.HttpStatusCode.NotFound
                                           or System.Net.HttpStatusCode.Gone;

                return new CoubDownloadResult
                {
                    Id = id,
                    Success = false,
                    Gone = gone,
                    Error = gone ? "Ролик удалён с coub.com" : ex.Message,
                };
            }
        }

        // ─── Метаданные ────────────────────────────────────────────────────────

        /// <summary>
        /// Спрашивает у Coub всё, что знает о ролике. Ошибку не бросает:
        /// один недоступный ролик не должен обрывать обход библиотеки.
        /// </summary>
        public async Task<CoubMetadata> FetchMetadataAsync(string id)
        {
            var client = _httpClientFactory.CreateClient("Coub");

            try
            {
                var json = await GetStringAsync(
                    client, $"https://coub.com/api/v2/coubs/{id}", CoubUserAgents.GetRandomAgent());
                return ParseMetadata(id, JObject.Parse(json));
            }
            catch (Exception ex)
            {
                var gone = ex is HttpRequestException http &&
                           http.StatusCode is System.Net.HttpStatusCode.NotFound
                                           or System.Net.HttpStatusCode.Gone;

                return new CoubMetadata { Id = id, Gone = gone, Error = ex.Message };
            }
        }

        internal static CoubMetadata ParseMetadata(string id, JObject data)
        {
            var meta = new CoubMetadata
            {
                Id = id,
                Title = Trimmed(data["title"]?.ToString()),
                ChannelId = data["channel_id"]?.Value<long?>() ?? data.SelectToken("channel.id")?.Value<long?>(),
                ChannelTitle = Trimmed(data.SelectToken("channel.title")?.ToString()),
                Duration = data["duration"]?.Value<double?>(),

                // not_safe_for_work у обычных роликов приходит пустым — тем,
                // что Coub реально заполняет, оказался age_restricted.
                // Берём первый непустой, чтобы не зависеть от того, какой
                // из них сайт решит использовать дальше
                Nsfw = data["not_safe_for_work"]?.Value<bool?>()
                    ?? data["age_restricted"]?.Value<bool?>()
                    ?? data["age_restricted_by_admin"]?.Value<bool?>(),
            };

            // dimensions: { "big": [1280, 720], "med": [640, 360] } — берём
            // большее, оно же соответствует скачиваемому потоку
            var big = data.SelectToken("dimensions.big") as JArray
                   ?? data.SelectToken("dimensions.med") as JArray;
            if (big is { Count: >= 2 })
            {
                meta.Width = big[0].Value<int?>();
                meta.Height = big[1].Value<int?>();
            }

            foreach (var tag in data["tags"] as JArray ?? new JArray())
            {
                var title = Trimmed(tag["title"]?.ToString());
                if (title != null) meta.Tags.Add(title);
            }

            return meta;
        }

        private static string? Trimmed(string? value)
        {
            var trimmed = value?.Trim();
            return string.IsNullOrEmpty(trimmed) ? null : trimmed;
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