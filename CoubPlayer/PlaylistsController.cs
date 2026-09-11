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
        private readonly CoubListService _coubListService;

        private static readonly string[] SyncCategories = { "liked", "bookmarks" };

        public PlaylistsController(CoubDownloadService downloadService, CoubTimelineService timelineService, CoubListService coubListService)
        {
            _downloadService = downloadService;
            _timelineService = timelineService;
            _coubListService = coubListService;
        }

        #region Icons

        private void EnsurePlaylistsFileExists()
        {
            if (System.IO.File.Exists(_path)) return;

            var dir = Path.GetDirectoryName(_path)!;
            Directory.CreateDirectory(dir);

            var emptyJson = JsonConvert.SerializeObject(new Dictionary<string, Playlist>(), Formatting.Indented);
            var tempPath = _path + ".tmp";
            System.IO.File.WriteAllText(tempPath, emptyJson);

            if (System.IO.File.Exists(_path))
                System.IO.File.Replace(tempPath, _path, null);
            else
                System.IO.File.Move(tempPath, _path);
        }

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

        #region Banners

        private readonly string _bannersPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "banners");

        private const int BANNER_W = 960;
        private const int BANNER_H = 540;

        private static readonly string[] AllowedBannerVideoExt = { ".mp4", ".webm" };

        private void DeleteBannerFile(string? fileName)
        {
            if (string.IsNullOrEmpty(fileName)) return;
            var path = Path.Combine(_bannersPath, Path.GetFileName(fileName));
            if (System.IO.File.Exists(path)) System.IO.File.Delete(path);
        }

        private void DeleteAllBannerFiles(Playlist pl)
        {
            DeleteBannerFile(pl.banner?.image);
            DeleteBannerFile(pl.banner?.video);
        }

        /// <summary>
        /// Своя картинка для баннера. Клиент присылает уже обрезанный под 16:9
        /// кадр (позиционирование и масштаб он же и делает), тут остаётся
        /// привести к одному размеру и формату.
        /// </summary>
        [HttpPost("{playlist}/banner")]
        public IActionResult SetBannerImage([FromRoute] string playlist, IFormFile file)
        {
            if (file == null || file.Length == 0)
                return BadRequest("No file");

            Directory.CreateDirectory(_bannersPath);

            using var inputStream = file.OpenReadStream();
            using var original = SKBitmap.Decode(inputStream);
            if (original == null) return BadRequest("Unsupported image");

            using var resized = original.Resize(
                new SKImageInfo(BANNER_W, BANNER_H), SKFilterQuality.High);
            if (resized == null) return BadRequest("Resize failed");

            var fileName = $"b_{Guid.NewGuid():N}.webp";
            using (var output = System.IO.File.OpenWrite(Path.Combine(_bannersPath, fileName)))
                resized.Encode(output, SKEncodedImageFormat.Webp, 88);

            var result = ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist)) return NotFound();

                var pl = data[playlist];
                pl.banner ??= new PlaylistBanner();
                DeleteBannerFile(pl.banner.image);
                pl.banner.image = fileName;

                return Ok(new { url = $"/Data/banners/{fileName}" });
            });

            // Плейлиста не оказалось — не оставляем осиротевший файл
            if (result is not (OkResult or OkObjectResult))
                DeleteBannerFile(fileName);

            return result;
        }

        /// <summary>Свой анимированный баннер. Файл сохраняется как есть.</summary>
        [HttpPost("{playlist}/banner-video")]
        public async Task<IActionResult> SetBannerVideo([FromRoute] string playlist, IFormFile file)
        {
            if (file == null || file.Length == 0)
                return BadRequest("No file");

            var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
            if (!AllowedBannerVideoExt.Contains(ext))
                return BadRequest("Поддерживаются только mp4 и webm");

            Directory.CreateDirectory(_bannersPath);

            var fileName = $"b_{Guid.NewGuid():N}{ext}";
            await using (var output = System.IO.File.Create(Path.Combine(_bannersPath, fileName)))
                await file.CopyToAsync(output);

            var result = ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist)) return NotFound();

                var pl = data[playlist];
                pl.banner ??= new PlaylistBanner();
                DeleteBannerFile(pl.banner.video);
                pl.banner.video = fileName;

                return Ok(new { url = $"/Data/banners/{fileName}" });
            });

            if (result is not (OkResult or OkObjectResult))
                DeleteBannerFile(fileName);

            return result;
        }

        /// <summary>
        /// Сбрасывает баннер к значению по умолчанию (превью первого ролика).
        /// kind: "image" | "video" | "all".
        /// </summary>
        [HttpDelete("{playlist}/banner")]
        public IActionResult DeleteBanner([FromRoute] string playlist, [FromQuery] string kind = "all")
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist)) return NotFound();

                var pl = data[playlist];
                if (pl.banner == null) return Ok();

                if (kind is "image" or "all")
                {
                    DeleteBannerFile(pl.banner.image);
                    pl.banner.image = null;
                }
                if (kind is "video" or "all")
                {
                    DeleteBannerFile(pl.banner.video);
                    pl.banner.video = null;
                }

                if (pl.banner.IsEmpty) pl.banner = null;
                return Ok();
            });
        }

        #endregion

        private IActionResult ExecuteLocked(Func<Dictionary<string, Playlist>, IActionResult> action)
        {
            lock (_lock)
            {
                EnsurePlaylistsFileExists();

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
                EnsurePlaylistsFileExists(); // NEW
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

                DeleteAllBannerFiles(data[playlist]);

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

                // Может прийти как точный ключ записи, так и id куба — во втором
                // случае ролик лежит в плейлисте копией ("id#2"), и убрать нужно
                // первую попавшуюся его запись. Искать ключ на клиенте нельзя:
                // его копия плейлистов могла устареть.
                var key = pl.videos.ContainsKey(req.Id)
                    ? req.Id
                    : pl.videos.Keys.FirstOrDefault(k => BaseCoubId(k) == req.Id);

                if (key == null)
                    return NotFound();

                var removedOrder = pl.videos[key].order;
                pl.videos.Remove(key);

                foreach (var video in pl.videos.Values)
                {
                    if (video.order > removedOrder)
                        video.order -= 1;
                }

                return Ok();
            });
        }

        /// <summary>
        /// Ключ записи в плейлисте — это либо id куба, либо "id#N" для копии.
        /// Сами файлы при дублировании не копируются: обе записи ссылаются
        /// на один и тот же ролик в coub_list.json.
        /// </summary>
        private static string BaseCoubId(string key)
        {
            var i = key.IndexOf('#');
            return i < 0 ? key : key.Substring(0, i);
        }

        private static string NextInstanceKey(Playlist pl, string baseId)
        {
            var n = 2;
            while (pl.videos.ContainsKey($"{baseId}#{n}")) n++;
            return $"{baseId}#{n}";
        }

        /// <summary>
        /// Добавляет в плейлист ещё одну запись того же ролика, сразу за исходной.
        /// Файлы не копируются — новая запись просто ссылается на тот же куб,
        /// но имеет собственные order и постобработку.
        /// </summary>
        [HttpPost("{playlist}/duplicate")]
        public IActionResult Duplicate([FromRoute] string playlist, [FromBody] DuplicateVideoRequest req)
        {
            if (string.IsNullOrWhiteSpace(req?.Id))
                return BadRequest("No id provided");

            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var pl = data[playlist];
                if (!pl.videos.TryGetValue(req.Id, out var source))
                    return NotFound("Video not in playlist");

                var newKey = NextInstanceKey(pl, BaseCoubId(req.Id));

                foreach (var video in pl.videos.Values)
                    if (video.order > source.order) video.order += 1;

                pl.videos[newKey] = new VideoMeta
                {
                    title = source.title,
                    order = source.order + 1,
                    fx = source.fx == null ? null : new Dictionary<string, double>(source.fx),
                    bgFx = source.bgFx == null ? null : new Dictionary<string, double>(source.bgFx),
                    bgSeparate = source.bgSeparate,
                };

                return Ok(new { key = newKey });
            });
        }

        /// <summary>
        /// Сохраняет персональную постобработку одной записи плейлиста.
        /// Пустой/отсутствующий Fx снимает настройки.
        /// </summary>
        [HttpPost("{playlist}/fx")]
        public IActionResult SetFx([FromRoute] string playlist, [FromBody] SetVideoFxRequest req)
        {
            if (string.IsNullOrWhiteSpace(req?.Id))
                return BadRequest("No id provided");

            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var pl = data[playlist];
                if (!pl.videos.TryGetValue(req.Id, out var meta))
                    return NotFound("Video not in playlist");

                meta.fx = req.Fx is { Count: > 0 } ? req.Fx : null;
                meta.bgSeparate = req.BgSeparate ? true : null;
                // bgFx имеет смысл только при отдельной настройке фона —
                // иначе не храним, чтобы файл не пух пустыми объектами
                meta.bgFx = req.BgSeparate && req.BgFx is { Count: > 0 } ? req.BgFx : null;
                return Ok();
            });
        }

        /// <summary>
        /// Переставляет ролики в плейлисте (drag and drop в режиме плитки).
        /// Ids может быть подмножеством плейлиста — в сетке могут быть включены
        /// поиск или фильтр по тегам, и тогда пользователь видит и таскает не всё.
        /// Поэтому переставляем не «сквозной нумерацией», а по занятым позициям:
        /// берём order'ы именно этих роликов, сортируем и раздаём в новом порядке.
        /// Ролики, которых нет в списке, остаются на своих местах.
        /// </summary>
        [HttpPost("{playlist}/reorder")]
        public IActionResult Reorder([FromRoute] string playlist, [FromBody] ReorderPlaylistRequest req)
        {
            if (req?.Ids == null || req.Ids.Count == 0)
                return BadRequest("No ids provided");

            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var pl = data[playlist];

                var unknown = req.Ids.Where(id => !pl.videos.ContainsKey(id)).ToList();
                if (unknown.Count > 0)
                    return BadRequest($"Not in playlist: {string.Join(", ", unknown)}");

                if (req.Ids.Distinct().Count() != req.Ids.Count)
                    return BadRequest("Duplicate ids");

                var slots = req.Ids.Select(id => pl.videos[id].order).OrderBy(o => o).ToList();
                for (var i = 0; i < req.Ids.Count; i++)
                    pl.videos[req.Ids[i]].order = slots[i];

                return Ok();
            });
        }

        /// <summary>Собирает плейлист в группу (пустое имя — убрать из группы).</summary>
        [HttpPost("{playlist}/group")]
        public IActionResult SetGroup([FromRoute] string playlist, [FromBody] SetGroupRequest req)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var group = req?.Group?.Trim();
                data[playlist].group = string.IsNullOrEmpty(group) ? null : group;
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

            int limit;
            if (req.Limit == -1)
                limit = -1;
            else if (req.Limit <= 0)
                limit = 25;
            else
                limit = req.Limit;

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
            var jitter = new Random();
            var total = urls.Count;
            var index = 0;
            var needsDelay = false;

            ConsoleLog.Section($"ЗАГРУЗКА: {playlist} ({total} роликов)");

            foreach (var url in urls)
            {
                index++;

                if (needsDelay) await Task.Delay(1500 + jitter.Next(0, 800));

                var counter = $"[{index,4}/{total}]";
                ConsoleLog.Info($"  {counter} {url}");

                var result = await _downloadService.DownloadAsync(url);
                results.Add(result);

                needsDelay = result.Success && !result.AlreadyExisted;

                if (!result.Success)
                {
                    ConsoleLog.Error($"  {counter} [{result.Id}] {result.Error}");
                    continue;
                }

                if (result.AlreadyExisted)
                    ConsoleLog.Muted($"  {counter} уже скачано ранее, пропускаем: {result.Id} \"{result.Title}\"");
                else
                    ConsoleLog.Success($"  {counter} {result.Id} \"{result.Title}\"");

                UpsertCoubListEntry(result);

                ExecuteLocked(data =>
                {
                    if (!data.ContainsKey(playlist)) return NotFound();

                    var pl = data[playlist];

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

            ConsoleLog.Divider();
            ConsoleLog.Success($"[{playlist}] Загрузка завершена: успешно {results.Count(r => r.Success)}/{total}");
            ConsoleLog.Divider();

            return results;
        }
    }
}