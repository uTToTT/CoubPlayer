using CoubPlayer.Requests;
using CoubPlayer.Services;
using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace CoubPlayer
{
    /// <summary>
    /// Точка входа для браузерного расширения.
    ///
    /// Расширение живёт на coub.com и умеет то, чего не может сервер, — ходить
    /// в приватный API от имени залогиненного пользователя. Обычно скачиванием
    /// занимается сервер: расширение лишь присылает ссылки
    /// в /api/playlists/{playlist}/download.
    ///
    /// Но сервер не всегда достаёт до coub.com — провайдер может его
    /// блокировать, а VPN быть только в браузере. Тогда файлы тянет
    /// расширение, и ему нужен план: что именно качать (Plan) и куда
    /// принести (/api/playlists/{playlist}/upload).
    ///
    /// Здесь же и то, что расширению нужно знать заранее: жив ли сервер,
    /// куда складывать и что уже скачано.
    /// </summary>
    [ApiController]
    [Route("api/extension")]
    public class ExtensionController : ControllerBase
    {
        private readonly CoubDownloadService _downloads;
        private readonly PlaylistRepository _playlists;
        private readonly CoubRepository _coubs;
        private readonly GroupOrderRepository _groups;
        private readonly SuggestionRepository _suggestions;

        public ExtensionController(
            CoubDownloadService downloads,
            PlaylistRepository playlists,
            CoubRepository coubs,
            GroupOrderRepository groups,
            SuggestionRepository suggestions)
        {
            _downloads = downloads;
            _playlists = playlists;
            _coubs = coubs;
            _groups = groups;
            _suggestions = suggestions;
        }

        /// <summary>
        /// Рукопожатие: расширение зовёт его, чтобы отличить запущенный
        /// CoubPlayer от случайного сервиса на том же порту.
        /// </summary>
        [HttpGet("ping")]
        public IActionResult Ping()
        {
            return Ok(new
            {
                app = "CoubPlayer",
                api = 1,
                version = AppVersion.Current,
                playlists = _playlists.ReadNames(),
            });
        }

        /// <summary>
        /// Что качать для одного ролика, когда качает не сервер, а расширение.
        ///
        /// Зовётся дважды. Сперва без метаданных — это дешёвый вопрос «файлы
        /// уже на диске?», и ответ «да» экономит трафик VPN, ради которого всё
        /// и затевалось. Получив needsMeta, расширение идёт на coub.com
        /// и присылает ответ сюда: какие потоки из него брать, решает сервер.
        /// </summary>
        [HttpPost("plan")]
        public IActionResult Plan([FromBody] CoubPlanRequest req)
        {
            if (!CoubDownloadService.IsSafeId(req?.Id))
                return BadRequest("Некорректный id ролика");

            JObject? meta = null;
            if (!string.IsNullOrWhiteSpace(req!.Meta))
            {
                try
                {
                    meta = JObject.Parse(req.Meta);
                }
                catch (JsonException)
                {
                    return BadRequest("Метаданные не разобрались как JSON");
                }
            }

            return Ok(_downloads.Plan(req.Id!, meta));
        }

        /// <summary>
        /// Что расширение вычитает из найденного в ленте, чтобы прислать только
        /// недостающее.
        ///
        /// С параметром playlist — id роликов именно в нём, и это то, что нужно
        /// при догрузке ленты: сверяться со всей библиотекой нельзя, иначе куб,
        /// скачанный когда-то в другой плейлист, в этот уже никогда не попадёт.
        /// Без параметра — вся библиотека.
        /// </summary>
        [HttpGet("library")]
        public IActionResult Library([FromQuery] string? playlist)
        {
            return Ok(new
            {
                ids = string.IsNullOrEmpty(playlist)
                    ? _coubs.ReadIds()
                    : _playlists.ReadCoubIds(playlist),
            });
        }

        /// <summary>
        /// Плейлисты, которые пользователь привык видеть в плеере, для меню
        /// кнопки на coub.com.
        ///
        /// С параметром coub у каждого проставляется признак, лежит ли этот
        /// ролик уже в нём — чтобы в меню было видно, куда его добавлять смысла
        /// нет. Ролик может лежать копией, поэтому сверяем по id, а не по ключу.
        ///
        /// Рядом отдаётся порядок групп: раскладывает по ним уже расширение,
        /// но собирать это двумя запросами незачем.
        ///
        /// У каждого плейлиста — ссылка на картинку, та же, что в плеере:
        /// см. <see cref="BannerUrl"/>.
        /// </summary>
        [HttpGet("playlists")]
        public IActionResult Playlists([FromQuery] string? coub)
        {
            var playlists = _playlists.ReadSummaries(coub)
                .Select((p, index) => new
                {
                    p.Name, p.Count, p.Order, p.Group, p.HasCoub,
                    Banner = BannerUrl(p),
                    index,
                })
                // Тот же порядок, что в плеере (sortPlaylistEntries в ui.js):
                // сперва расставленные перетаскиванием, затем привычные
                // bookmarks/liked, остальные — как лежат в базе
                .OrderBy(x => x.Order ?? int.MaxValue)
                .ThenBy(x => x.Order.HasValue ? 0 : PriorityRank(x.Name))
                .ThenBy(x => x.index)
                .Select(x => new
                {
                    name = x.Name,
                    count = x.Count,
                    order = x.Order,
                    group = x.Group,
                    hasCoub = x.HasCoub,
                    banner = x.Banner,
                });

            return Ok(new { playlists, groupOrder = _groups.ReadPlaylistGroups() });
        }

        // ─── Картинка плейлиста ─────────────────────────────────────────────

        private static readonly string BannersPath = DataDir("banners");
        private static readonly string IconsPath = DataDir("icons");
        private static readonly string ThumbsPath = DataDir("thumbs");

        private static string DataDir(string name) =>
            Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "Data", name);

        /// <summary>
        /// Ссылка на картинку плейлиста — в том же порядке предпочтения, что
        /// и в плеере (buildBannerEl в banner.js): своя загруженная картинка,
        /// затем старый значок, затем кадр ролика, который в плейлисте
        /// по умолчанию. Ничего из этого нет — null, и расширение нарисует
        /// букву, как делает плеер.
        ///
        /// Файлы проверяются на месте: в базе лежит только имя своей картинки,
        /// а значок и кадр — это просто файлы, которых может и не быть.
        /// </summary>
        private static string? BannerUrl(PlaylistRepository.Summary p)
        {
            if (!string.IsNullOrEmpty(p.BannerImage) &&
                System.IO.File.Exists(Path.Combine(BannersPath, p.BannerImage)))
                return $"/Data/banners/{Uri.EscapeDataString(p.BannerImage)}";

            var icon = string.Concat(p.Name.Split(Path.GetInvalidFileNameChars()));
            if (icon.Length > 0 && System.IO.File.Exists(Path.Combine(IconsPath, $"{icon}.webp")))
                return $"/Data/icons/{Uri.EscapeDataString(icon)}.webp";

            if (!string.IsNullOrEmpty(p.CoverCoubId) &&
                System.IO.File.Exists(Path.Combine(ThumbsPath, $"{p.CoverCoubId}.webp")))
                return $"/Data/thumbs/{Uri.EscapeDataString(p.CoverCoubId)}.webp";

            return null;
        }

        /// <summary>
        /// Куда этот ролик просится: те же подсказки, что плеер показывает
        /// в панели плейлистов, но для ролика, который пользователь сейчас
        /// смотрит на coub.com.
        ///
        /// Тонкость в том, что подсказки считаются по тегам, а у нескачанного
        /// ролика тегов в базе нет. Поэтому расширение прикладывает ответ
        /// coub.com — тот самый, что оно и так запрашивает ради ссылок на
        /// файлы, — и теги берутся оттуда. Для уже скачанного ролика ничего
        /// прикладывать не надо: теги лежат в базе.
        /// </summary>
        [HttpPost("suggest")]
        public IActionResult Suggest([FromBody] CoubPlanRequest req)
        {
            if (!CoubDownloadService.IsSafeId(req?.Id))
                return BadRequest("Некорректный id ролика");

            if (!string.IsNullOrWhiteSpace(req!.Meta))
            {
                List<string> tags;
                try
                {
                    tags = CoubDownloadService.ParseMetadata(req.Id!, JObject.Parse(req.Meta)).Tags;
                }
                catch (JsonException)
                {
                    return BadRequest("Метаданные не разобрались как JSON");
                }

                var byTags = _suggestions.SuggestByTags(req.Id!, tags);
                return Ok(new { playlists = byTags.playlists, tags = byTags.tags, needsMeta = false });
            }

            // Тегов в базе нет — считать не из чего. Сообщаем об этом отдельно
            // от «посчитали и ничего не нашлось»: в первом случае расширению
            // есть смысл сходить на coub.com, во втором — нет
            if (!_suggestions.HasTags(req.Id!))
            {
                return Ok(new
                {
                    playlists = new List<PlaylistSuggestion>(),
                    tags = new List<TagSuggestion>(),
                    needsMeta = true,
                });
            }

            var stored = _suggestions.Suggest(req.Id!);
            return Ok(new { playlists = stored.playlists, tags = stored.tags, needsMeta = false });
        }

        /// <summary>
        /// «Все» виртуальный и на сервере не хранится, поэтому здесь только
        /// две привычные ленты — как в PRIORITY_ORDER на стороне плеера.
        /// </summary>
        private static int PriorityRank(string name) => name switch
        {
            "bookmarks" => 0,
            "liked" => 1,
            _ => 2,
        };
    }
}
