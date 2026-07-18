using CoubPlayer.Meta;
using CoubPlayer.Requests;
using CoubPlayer.Services;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using SkiaSharp;
using System.Linq;

namespace CoubPlayer
{
    [ApiController]
    [Route("api/playlists")]
    public class PlaylistsController : ControllerBase
    {
        private readonly string _path = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "playlists.json");

        private readonly string _coubListPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "coub_list.json");

        private readonly string _iconsPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "icons");

        private static readonly object _lock = new();
        private static readonly object _coubListLock = new();

        private readonly CoubDownloadService _downloadService;
        private readonly CoubTimelineService _timelineService;

        private static readonly string[] SyncCategories = { "liked", "bookmarks" };

        public PlaylistsController(CoubDownloadService downloadService, CoubTimelineService timelineService)
        {
            _downloadService = downloadService;
            _timelineService = timelineService;
        }

        #region Icons

        [HttpPost("{playlist}/icon")]
        public IActionResult SetIcon([FromRoute] string playlist, IFormFile file)
        {
            if (file == null || file.Length == 0)
                return BadRequest("No file");

            lock (_lock)
            {
                var json = System.IO.File.ReadAllText(_path);
                var data = JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json)!;
                if (!data.ContainsKey(playlist))
                    return NotFound();
            }

            Directory.CreateDirectory(_iconsPath);

            var iconPath = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");

            // Ресайз через SkiaSharp
            using var inputStream = file.OpenReadStream();
            using var original = SKBitmap.Decode(inputStream);

            const int SIZE = 256;
            var scale = Math.Max((float)SIZE / original.Width, (float)SIZE / original.Height);
            var srcW = (int)(SIZE / scale);
            var srcH = (int)(SIZE / scale);
            var srcX = (original.Width - srcW) / 2;
            var srcY = (original.Height - srcH) / 2;

            using var cropped = new SKBitmap(SIZE, SIZE);
            using var canvas = new SKCanvas(cropped);
            canvas.DrawBitmap(original,
                new SKRect(srcX, srcY, srcX + srcW, srcY + srcH),
                new SKRect(0, 0, SIZE, SIZE));

            using var output = System.IO.File.OpenWrite(iconPath);
            cropped.Encode(output, SKEncodedImageFormat.Webp, 85);

            return Ok(new { url = $"/Data/icons/{SanitizeFileName(playlist)}.webp" });
        }

        [HttpDelete("{playlist}/icon")]
        public IActionResult DeleteIcon([FromRoute] string playlist)
        {
            var iconPath = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");
            if (System.IO.File.Exists(iconPath))
                System.IO.File.Delete(iconPath);
            return Ok();
        }

        private static string SanitizeFileName(string name) =>
            string.Concat(name.Split(Path.GetInvalidFileNameChars()));

        #endregion

        private IActionResult ExecuteLocked(Func<Dictionary<string, Playlist>, IActionResult> action)
        {
            lock (_lock)
            {
                var json = System.IO.File.ReadAllText(_path);
                var data = JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json)!;

                var result = action(data);

                // Сохраняем только если операция успешна
                if (result is OkResult or OkObjectResult)
                {
                    var newJson = JsonConvert.SerializeObject(data, Formatting.Indented);
                    var tempPath = _path + ".tmp";
                    System.IO.File.WriteAllText(tempPath, newJson);
                    System.IO.File.Replace(tempPath, _path, null);
                }

                return result;
            }
        }

        [HttpGet]
        public IActionResult Get()
        {
            lock (_lock)
            {
                var json = System.IO.File.ReadAllText(_path);
                return Content(json, "application/json");
            }
        }

        [HttpPost]
        public IActionResult Create([FromBody] CreatePlaylistRequest req)
        {
            return ExecuteLocked(data =>
            {
                if (data.ContainsKey(req.Name))
                    return BadRequest("Playlist exists");

                data[req.Name] = new Playlist
                {
                    title = req.Name,
                    videos = new Dictionary<string, VideoMeta>()
                };

                return Ok();
            });
        }

        [HttpPost("{playlist}/delete")]
        public IActionResult Delete([FromRoute] string playlist)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var iconPath = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");
                if (System.IO.File.Exists(iconPath))
                    System.IO.File.Delete(iconPath);

                data.Remove(playlist);
                return Ok();
            });
        }

        [HttpPost("{playlist}/rename")]
        public IActionResult Rename([FromRoute] string playlist, [FromBody] RenamePlaylistRequest req)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                if (data.ContainsKey(req.NewName))
                    return BadRequest("Playlist exists");

                var pl = data[playlist];
                pl.title = req.NewName;

                var oldIcon = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");
                var newIcon = Path.Combine(_iconsPath, $"{SanitizeFileName(req.NewName)}.webp");
                if (System.IO.File.Exists(oldIcon))
                    System.IO.File.Move(oldIcon, newIcon, overwrite: true);

                data.Remove(playlist);
                data[req.NewName] = pl;

                return Ok();
            });
        }

        [HttpPost("{playlist}/add")]
        public IActionResult AddVideo([FromRoute] string playlist, [FromBody] AddVideoRequest req)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var pl = data[playlist];

                foreach (var video in pl.videos.Values)
                    video.order += 1;

                pl.videos[req.id] = new VideoMeta
                {
                    title = req.title,
                    order = 0
                };

                return Ok();
            });
        }

        [HttpPost("{playlist}/remove")]
        public IActionResult RemoveVideo([FromRoute] string playlist, [FromBody] RemoveVideoRequest req)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var pl = data[playlist];

                if (!pl.videos.ContainsKey(req.Id))
                    return NotFound();

                var removedOrder = pl.videos[req.Id].order;
                pl.videos.Remove(req.Id);

                foreach (var video in pl.videos.Values)
                {
                    if (video.order > removedOrder)
                        video.order -= 1;
                }

                return Ok();
            });
        }

        [HttpPost("{playlist}/viewed")]
        public IActionResult MarkViewed([FromRoute] string playlist, [FromBody] ViewVideoRequest req)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var pl = data[playlist];

                if (!pl.videos.ContainsKey(req.id))
                    return NotFound();

                pl.videos[req.id].lastViewed = DateTime.UtcNow;

                return Ok();
            });
        }

        /// <summary>
        /// Добавляет или обновляет запись ролика в coub_list.json — именно оттуда
        /// loader.js строит coubMap ({id, video, audio}), по которому плеер
        /// резолвит реальные src для video/audio. Без этого шага скачанные файлы
        /// физически лежат на диске, но плеер их не найдёт.
        /// </summary>
        private void UpsertCoubListEntry(CoubDownloadResult result)
        {
            if (string.IsNullOrEmpty(result.Video)) return;

            lock (_coubListLock)
            {
                List<CoubListEntry> list;
                if (System.IO.File.Exists(_coubListPath))
                {
                    var json = System.IO.File.ReadAllText(_coubListPath);
                    list = JsonConvert.DeserializeObject<List<CoubListEntry>>(json) ?? new List<CoubListEntry>();
                }
                else
                {
                    list = new List<CoubListEntry>();
                }

                var existing = list.FirstOrDefault(c => c.id == result.Id);
                if (existing != null)
                {
                    existing.video = result.Video;
                    existing.audio = result.Audio ?? existing.audio;
                }
                else
                {
                    list.Add(new CoubListEntry
                    {
                        id = result.Id,
                        video = result.Video,
                        audio = result.Audio ?? ""
                    });
                }

                var newJson = JsonConvert.SerializeObject(list, Formatting.Indented);
                var tempPath = _coubListPath + ".tmp";
                System.IO.File.WriteAllText(tempPath, newJson);

                if (System.IO.File.Exists(_coubListPath))
                    System.IO.File.Replace(tempPath, _coubListPath, null);
                else
                    System.IO.File.Move(tempPath, _coubListPath);
            }
        }

        /// <summary>
        /// Скачивает один или несколько coub-роликов по ссылкам и добавляет их
        /// в указанный плейлист. Ролики, уже присутствующие в плейлисте,
        /// повторно не добавляются (но при этом не переcкачиваются, если уже
        /// лежат на диске — см. CoubDownloadService.AlreadyExisted).
        /// </summary>
        [HttpPost("{playlist}/download")]
        public async Task<IActionResult> DownloadAndAdd(
            [FromRoute] string playlist, [FromBody] DownloadCoubsRequest req)
        {
            if (req.Urls == null || req.Urls.Count == 0)
                return BadRequest("No links provided");

            // Проверяем существование плейлиста один раз до скачивания —
            // чтобы не тратить время на загрузку видео впустую
            lock (_lock)
            {
                var json = System.IO.File.ReadAllText(_path);
                var data = JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json)!;
                if (!data.ContainsKey(playlist))
                    return NotFound("Playlist not found");
            }

            var results = await DownloadUrlsIntoPlaylistAsync(playlist, req.Urls);
            return Ok(results);
        }

        /// <summary>
        /// Докачивает свежие ролики из личной ленты liked/bookmarks пользователя
        /// (через приватный timeline API Coub, требует access token) и добавляет
        /// их в одноимённый плейлист ("liked" или "bookmarks" — как их узнаёт и
        /// main.js в pickDefaultPlaylist). Плейлист создаётся, если его ещё нет.
        /// Limit ограничивает, сколько НОВЕЙШИХ роликов ленты забрать за этот запуск
        /// (а не сколько реально новых будет добавлено — уже скачанные просто
        /// пропускаются, так же как при повторном вызове /download с теми же ссылками).
        /// </summary>
        [HttpPost("sync")]
        public async Task<IActionResult> SyncFavorites([FromBody] SyncRequest req)
        {
            if (!SyncCategories.Contains(req.Category))
                return BadRequest("Category must be 'liked' or 'bookmarks'");

            if (string.IsNullOrWhiteSpace(req.Token))
                return BadRequest("Token is required");

            var limit = req.Limit <= 0 ? 25 : Math.Min(req.Limit, 1000);

            // Плейлист для категории создаём, если его ещё нет
            ExecuteLocked(data =>
            {
                if (!data.ContainsKey(req.Category))
                {
                    data[req.Category] = new Playlist
                    {
                        title = req.Category,
                        videos = new Dictionary<string, VideoMeta>()
                    };
                }
                return Ok();
            });

            List<string> permalinks;
            try
            {
                permalinks = await _timelineService.GetPermalinksAsync(req.Category, req.Token, limit);
            }
            catch (InvalidOperationException ex)
            {
                // Неверный токен, неизвестная категория и т.п. — это ошибка запроса, не сервера
                return BadRequest(ex.Message);
            }

            if (permalinks.Count == 0)
                return Ok(new List<CoubDownloadResult>());

            var results = await DownloadUrlsIntoPlaylistAsync(req.Category, permalinks);
            return Ok(results);
        }

        /// <summary>
        /// Общая логика для /download и /sync: последовательно скачивает ролики
        /// (с паузой и джиттером между ними — см. комментарий внутри), регистрирует
        /// каждый в coub_list.json и добавляет в указанный плейлист.
        /// </summary>
        private async Task<List<CoubDownloadResult>> DownloadUrlsIntoPlaylistAsync(
            string playlist, List<string> urls)
        {
            var results = new List<CoubDownloadResult>();
            var first = true;
            var jitter = new Random();

            foreach (var url in urls)
            {
                // Пауза между запросами к API Coub — без неё на больших батчах (сотни роликов)
                // велик риск временной блокировки по IP. 2.5с — эмпирическое значение
                // из оригинального CoubDownloader, + случайный джиттер 0-800мс, чтобы
                // интервалы не были идеально ровными.
                if (!first) await Task.Delay(2500 + jitter.Next(0, 800));
                first = false;

                var result = await _downloadService.DownloadAsync(url);
                results.Add(result);

                if (!result.Success) continue;

                // 1. Регистрируем ролик в coub_list.json (coubMap для плеера)
                UpsertCoubListEntry(result);

                // 2. Добавляем в конкретный плейлист
                ExecuteLocked(data =>
                {
                    if (!data.ContainsKey(playlist)) return NotFound();

                    var pl = data[playlist];

                    // Не добавляем повторно, если ролик уже есть в этом плейлисте
                    if (pl.videos.ContainsKey(result.Id))
                        return Ok();

                    foreach (var video in pl.videos.Values)
                        video.order += 1;

                    pl.videos[result.Id] = new VideoMeta
                    {
                        title = result.Title ?? result.Id,
                        order = 0
                    };

                    return Ok();
                });
            }

            return results;
        }
    }
}