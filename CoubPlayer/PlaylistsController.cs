using CoubPlayer.Requests;
using CoubPlayer.Services;
using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SkiaSharp;

namespace CoubPlayer
{
    [ApiController]
    [Route("api/playlists")]
    public class PlaylistsController : ControllerBase
    {
        private readonly string _iconsPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "icons");

        private readonly CoubDownloadService _downloadService;
        private readonly CoubTimelineService _timelineService;
        private readonly PlaylistRepository _playlists;
        private readonly CoubRepository _coubs;

        private static readonly string[] SyncCategories = { "liked", "bookmarks" };

        public PlaylistsController(
            CoubDownloadService downloadService,
            CoubTimelineService timelineService,
            PlaylistRepository playlists,
            CoubRepository coubs)
        {
            _downloadService = downloadService;
            _timelineService = timelineService;
            _playlists = playlists;
            _coubs = coubs;
        }

        /// <summary>Переводит исход операции в ответ HTTP.</summary>
        private IActionResult Respond(PlaylistOutcome outcome, object? body = null) => outcome switch
        {
            PlaylistOutcome.Ok => body == null ? Ok() : Ok(body),
            PlaylistOutcome.NotFound => NotFound(),
            PlaylistOutcome.ItemNotFound => NotFound("Video not in playlist"),
            PlaylistOutcome.CoubNotFound => NotFound("Coub not in library"),
            PlaylistOutcome.Conflict => BadRequest("Playlist exists"),
            _ => StatusCode(500),
        };

        #region Icons

        [HttpPost("{playlist}/icon")]
        public IActionResult SetIcon([FromRoute] string playlist, IFormFile file)
        {
            if (file == null || file.Length == 0)
                return BadRequest("No file");

            if (!_playlists.Exists(playlist))
                return NotFound();

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

        /// <summary>
        /// У каких плейлистов есть старый значок (Data/icons/&lt;имя&gt;.webp).
        ///
        /// Нужен, чтобы клиент не выяснял это подбором. Раньше он на каждый
        /// плейлист заводил Image и ждал — загрузится или отвалится 404;
        /// на сотне плейлистов это сотня запросов, и список ждал каждый.
        /// </summary>
        [HttpGet("icons")]
        public IActionResult Icons()
        {
            if (!Directory.Exists(_iconsPath)) return Ok(new { names = Array.Empty<string>() });

            var names = Directory
                .EnumerateFiles(_iconsPath, "*.webp")
                .Select(Path.GetFileNameWithoutExtension)
                .Where(n => !string.IsNullOrEmpty(n))
                .ToList();

            return Ok(new { names });
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

            var outcome = _playlists.SetBanner(playlist, fileName, null, out var replaced);

            // Плейлиста не оказалось — не оставляем осиротевший файл
            if (outcome != PlaylistOutcome.Ok)
            {
                DeleteBannerFile(fileName);
                return Respond(outcome);
            }

            DeleteBannerFile(replaced);
            return Ok(new { url = $"/Data/banners/{fileName}" });
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

            var outcome = _playlists.SetBanner(playlist, null, fileName, out var replaced);

            if (outcome != PlaylistOutcome.Ok)
            {
                DeleteBannerFile(fileName);
                return Respond(outcome);
            }

            DeleteBannerFile(replaced);
            return Ok(new { url = $"/Data/banners/{fileName}" });
        }

        public class SetBannerCoubRequest
        {
            public string? Id { get; set; }
        }

        /// <summary>
        /// Делает баннером ролик из библиотеки.
        ///
        /// В отличие от своего файла, копировать здесь нечего: ролик уже лежит
        /// на диске, и баннер просто на него ссылается. Кадр для покоя тоже
        /// берётся его — тот самый, что снят для режима плитки.
        /// </summary>
        [HttpPost("{playlist}/banner-coub")]
        public IActionResult SetBannerCoub(
            [FromRoute] string playlist, [FromBody] SetBannerCoubRequest req)
        {
            if (!CoubDownloadService.IsSafeId(req?.Id))
                return BadRequest("Некорректный id ролика");

            // Ролика может не быть в библиотеке — тогда баннер ссылался бы
            // в пустоту, и на плитке осталась бы дыра
            if (!_coubs.ReadIds().Contains(req!.Id!))
                return BadRequest("Такого ролика нет в библиотеке");

            var outcome = _playlists.SetBannerCoub(playlist, req.Id!, out var replaced);
            if (outcome != PlaylistOutcome.Ok) return Respond(outcome);

            // Свой файл заменён выбранным роликом — держать его больше некому
            DeleteBannerFile(replaced);
            return Ok(new { id = req.Id });
        }

        /// <summary>
        /// Сбрасывает баннер к значению по умолчанию (превью первого ролика).
        /// kind: "image" | "video" | "all".
        /// </summary>
        [HttpDelete("{playlist}/banner")]
        public IActionResult DeleteBanner([FromRoute] string playlist, [FromQuery] string kind = "all")
        {
            var (outcome, orphaned) = _playlists.ClearBanner(playlist, kind);
            if (outcome != PlaylistOutcome.Ok) return Respond(outcome);

            foreach (var fileName in orphaned) DeleteBannerFile(fileName);
            return Ok();
        }

        #endregion

        /// <summary>
        /// Все плейлисты. Сериализуем Newtonsoft'ом, а не общим для MVC
        /// System.Text.Json: на Playlist и VideoMeta висят его атрибуты
        /// NullValueHandling.Ignore, и без них в ответе появились бы пустые
        /// поля, которых клиент там никогда не видел.
        /// </summary>
        [HttpGet]
        public IActionResult Get()
        {
            var json = JsonConvert.SerializeObject(_playlists.ReadAll(), Formatting.Indented);
            return Content(json, "application/json");
        }

        [HttpPost]
        public IActionResult Create([FromBody] CreatePlaylistRequest req)
        {
            if (string.IsNullOrWhiteSpace(req?.Name))
                return BadRequest("Playlist name is required");

            return Respond(_playlists.Create(req.Name));
        }

        [HttpPost("{playlist}/delete")]
        public IActionResult Delete([FromRoute] string playlist)
        {
            var (outcome, bannerImage, bannerVideo) = _playlists.Delete(playlist);
            if (outcome != PlaylistOutcome.Ok) return Respond(outcome);

            var iconPath = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");
            if (System.IO.File.Exists(iconPath))
                System.IO.File.Delete(iconPath);

            DeleteBannerFile(bannerImage);
            DeleteBannerFile(bannerVideo);

            return Ok();
        }

        [HttpPost("{playlist}/rename")]
        public IActionResult Rename([FromRoute] string playlist, [FromBody] RenamePlaylistRequest req)
        {
            if (string.IsNullOrWhiteSpace(req?.NewName))
                return BadRequest("New name is required");

            var outcome = _playlists.Rename(playlist, req.NewName);
            if (outcome != PlaylistOutcome.Ok) return Respond(outcome);

            // Значок ключуется именем плейлиста — переносим за ним
            var oldIcon = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");
            var newIcon = Path.Combine(_iconsPath, $"{SanitizeFileName(req.NewName)}.webp");
            if (System.IO.File.Exists(oldIcon))
                System.IO.File.Move(oldIcon, newIcon, overwrite: true);

            return Ok();
        }

        [HttpPost("{playlist}/add")]
        public IActionResult AddVideo([FromRoute] string playlist, [FromBody] AddVideoRequest req) =>
            Respond(_playlists.AddVideo(playlist, req.id, req.title));

        [HttpPost("{playlist}/remove")]
        public IActionResult RemoveVideo([FromRoute] string playlist, [FromBody] RemoveVideoRequest req) =>
            Respond(_playlists.RemoveVideo(playlist, req.Id));

        /// <summary>
        /// Добавляет в плейлист ещё одну запись того же ролика, сразу за исходной.
        /// Файлы не копируются — новая запись просто ссылается на тот же куб,
        /// но имеет собственные позицию и постобработку.
        /// </summary>
        [HttpPost("{playlist}/duplicate")]
        public IActionResult Duplicate([FromRoute] string playlist, [FromBody] DuplicateVideoRequest req)
        {
            if (string.IsNullOrWhiteSpace(req?.Id))
                return BadRequest("No id provided");

            var (outcome, key) = _playlists.Duplicate(playlist, req.Id);
            return Respond(outcome, key == null ? null : new { key });
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

            return Respond(_playlists.SetFx(playlist, req.Id, req.Fx, req.BgFx, req.BgSeparate));
        }

        /// <summary>
        /// Переставляет ролики в плейлисте (drag and drop в режиме плитки).
        /// Ids может быть подмножеством плейлиста — в сетке могут быть включены
        /// поиск или фильтр по тегам, и тогда пользователь видит и таскает не всё.
        /// </summary>
        [HttpPost("{playlist}/reorder")]
        public IActionResult Reorder([FromRoute] string playlist, [FromBody] ReorderPlaylistRequest req)
        {
            if (req?.Ids == null || req.Ids.Count == 0)
                return BadRequest("No ids provided");

            var outcome = _playlists.Reorder(playlist, req.Ids, out var error);

            if (outcome == PlaylistOutcome.ItemNotFound) return BadRequest(error);
            return Respond(outcome);
        }

        public class AlignToFeedRequest
        {
            /// <summary>Лента как есть, от новых к старым. Собирает её расширение.</summary>
            public List<string>? Feed { get; set; }
        }

        /// <summary>
        /// Приводит порядок плейлиста к порядку ленты на сайте.
        ///
        /// Нужно потому, что ролик, скачанный кнопкой на странице, ложится
        /// в начало: ленты в этот момент нет, и место ролика взять неоткуда.
        /// Десяток таких — и порядок разошёлся с сайтом.
        ///
        /// Перед перестановкой делаем копию: меняется раскладка нескольких
        /// тысяч записей разом, а раскладка — единственное, что не
        /// восстанавливается перекачиванием.
        /// </summary>
        [HttpPost("{playlist}/align")]
        public IActionResult AlignToFeed(
            [FromRoute] string playlist,
            [FromBody] AlignToFeedRequest req,
            [FromServices] BackupService backups)
        {
            if (req?.Feed == null || req.Feed.Count == 0)
                return BadRequest("Пустая лента — нечем выравнивать");

            try
            {
                backups.Create();
            }
            catch (Exception ex)
            {
                // Без копии за такое не беремся: это не та операция, которую
                // стоит делать «на авось»
                return StatusCode(500, $"Не удалось сделать копию перед перестановкой: {ex.Message}");
            }

            var (outcome, matched, extra) = _playlists.AlignToFeed(playlist, req.Feed);
            if (outcome == PlaylistOutcome.NotFound) return NotFound("Playlist not found");

            ConsoleLog.Info(
                $"[{playlist}] порядок выровнен по ленте: по ленте {matched}, вне ленты {extra}");

            return Ok(new { matched, extra });
        }

        /// <summary>
        /// Раскладывает плейлисты в заданном порядке. Приходит полный список,
        /// поэтому просто нумеруем по позиции; не названные оставляем как были.
        /// </summary>
        [HttpPost("order")]
        public IActionResult ReorderPlaylists([FromBody] ReorderPlaylistsRequest req)
        {
            if (req?.Names == null || req.Names.Count == 0)
                return BadRequest("No names provided");

            _playlists.SetOrder(req.Names);
            return Ok();
        }

        /// <summary>Собирает плейлист в группу (пустое имя — убрать из группы).</summary>
        [HttpPost("{playlist}/group")]
        public IActionResult SetGroup([FromRoute] string playlist, [FromBody] SetGroupRequest req) =>
            Respond(_playlists.SetGroup(playlist, req?.Group?.Trim()));

        [HttpPost("{playlist}/viewed")]
        public IActionResult MarkViewed([FromRoute] string playlist, [FromBody] ViewVideoRequest req) =>
            Respond(_playlists.MarkViewed(playlist, req.id));

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
            if (!_playlists.Exists(playlist))
                return NotFound("Playlist not found");

            var results = await DownloadUrlsIntoPlaylistAsync(playlist, req.Urls, req.Order);
            return Ok(results);
        }

        /// <summary>
        /// Докачивает свежие ролики из личной ленты liked/bookmarks пользователя
        /// (через приватный timeline API Coub, требует access token) и добавляет
        /// их в одноимённый плейлист ("liked" или "bookmarks" — как их узнаёт и
        /// main.js в pickDefaultPlaylist). Плейлист создаётся, если его ещё нет.
        /// </summary>
        [HttpPost("sync")]
        public async Task<IActionResult> SyncFavorites([FromBody] SyncRequest req)
        {
            if (!SyncCategories.Contains(req.Category))
                return BadRequest("Category must be 'liked' or 'bookmarks'");

            if (string.IsNullOrWhiteSpace(req.Token))
                return BadRequest("Token is required");

            int limit;
            if (req.Limit == -1) limit = -1;
            else if (req.Limit <= 0) limit = 25;
            else limit = req.Limit;

            // Плейлист для категории создаём, если его ещё нет
            _playlists.Create(req.Category);

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
        /// (с паузой и джиттером между ними), регистрирует каждый в библиотеке
        /// и добавляет в указанный плейлист.
        /// </summary>
        private async Task<List<CoubDownloadResult>> DownloadUrlsIntoPlaylistAsync(
            string playlist, List<string> urls, List<string>? order = null)
        {
            var results = new List<CoubDownloadResult>();
            var jitter = new Random();
            var total = urls.Count;
            var index = 0;
            var needsDelay = false;

            // Порядок, которому следует плейлист. Без него таким порядком
            // считается сама пачка — тогда она целиком ложится в начало,
            // сохранив свою последовательность.
            var feed = order != null && order.Count > 0 ? order : urls;
            var feedIndex = BuildFeedIndex(feed);

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

                _coubs.Upsert(result);
                _playlists.AddAtFeedPosition(playlist, result.Id, result.Title, feed, feedIndex);
            }

            ConsoleLog.Divider();
            ConsoleLog.Success($"[{playlist}] Загрузка завершена: успешно {results.Count(r => r.Success)}/{total}");
            ConsoleLog.Divider();

            return results;
        }

        private static Dictionary<string, int> BuildFeedIndex(List<string> feed)
        {
            var feedIndex = new Dictionary<string, int>();
            for (var i = 0; i < feed.Count; i++) feedIndex.TryAdd(feed[i], i);
            return feedIndex;
        }

        // Ролик целиком, с запасом на самые тяжёлые: один coub — это единицы
        // мегабайт, но верхнюю границу лучше знать, чем угадывать
        private const long MaxUploadBytes = 128L * 1024 * 1024;

        /// <summary>
        /// Принимает файлы ролика, скачанные расширением в браузере.
        ///
        /// Нужно там, где до coub.com не достаёт сам сервер: провайдер
        /// блокирует сайт, а VPN есть только в браузере. Встроенный VPN
        /// браузера — это прокси для его собственного трафика, и запросы
        /// плеера, отдельного процесса, через него не идут.
        ///
        /// Дальше всё как при обычной загрузке: запись в библиотеку и место
        /// в плейлисте по порядку ленты.
        /// </summary>
        [HttpPost("{playlist}/upload")]
        [RequestSizeLimit(MaxUploadBytes)]
        [RequestFormLimits(MultipartBodyLengthLimit = MaxUploadBytes)]
        public async Task<IActionResult> UploadCoub(
            [FromRoute] string playlist, [FromForm] UploadCoubRequest req)
        {
            if (!CoubDownloadService.IsSafeId(req.Id))
                return BadRequest("Некорректный id ролика");

            if (req.Video == null || req.Video.Length == 0)
                return BadRequest("Пустой видео-файл");

            if (!_playlists.Exists(playlist))
                return NotFound("Playlist not found");

            CoubDownloadResult result;
            await using (var video = req.Video.OpenReadStream())
            await using (var audio = req.Audio is { Length: > 0 } a ? a.OpenReadStream() : null)
            {
                try
                {
                    result = await _downloadService.SaveUploadAsync(
                        req.Id!, req.Title, video, audio, req.AudioExt ?? "mp3");
                }
                catch (IOException ex)
                {
                    ConsoleLog.Error($"  [{req.Id}] не удалось записать файлы: {ex.Message}");
                    return StatusCode(500, $"Не удалось записать файлы: {ex.Message}");
                }
            }

            ConsoleLog.Success($"  [{result.Id}] принято от расширения \"{result.Title}\"");

            _coubs.Upsert(result);
            SaveUploadedMetadata(req.Id!, req.Meta);

            var feed = ParseOrder(req.Order) ?? new List<string> { result.Id };
            _playlists.AddAtFeedPosition(playlist, result.Id, result.Title, feed, BuildFeedIndex(feed));

            return Ok(result);
        }

        /// <summary>
        /// Сохраняет сведения о ролике, приехавшие вместе с файлами. Неудача
        /// здесь ничего не отменяет: файлы уже на месте, а теги доберёт
        /// отдельный проход.
        /// </summary>
        private void SaveUploadedMetadata(string id, string? rawMeta)
        {
            if (string.IsNullOrWhiteSpace(rawMeta)) return;

            try
            {
                var meta = CoubDownloadService.ParseMetadata(id, JObject.Parse(rawMeta));
                _coubs.SaveMetadata(meta);
            }
            catch (JsonException ex)
            {
                ConsoleLog.Muted($"  [{id}] сведения не разобрались: {ex.Message}");
            }
        }

        /// <summary>
        /// Порядок ленты приходит формой, а значит строкой. Разобрать не вышло —
        /// не повод отказывать в загрузке: ролик просто ляжет в начало плейлиста.
        /// </summary>
        private static List<string>? ParseOrder(string? order)
        {
            if (string.IsNullOrWhiteSpace(order)) return null;
            try
            {
                var parsed = JsonConvert.DeserializeObject<List<string>>(order);
                return parsed is { Count: > 0 } ? parsed : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }
}
