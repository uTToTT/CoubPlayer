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

        public ExtensionController(
            CoubDownloadService downloads,
            PlaylistRepository playlists,
            CoubRepository coubs,
            GroupOrderRepository groups)
        {
            _downloads = downloads;
            _playlists = playlists;
            _coubs = coubs;
            _groups = groups;
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
        /// </summary>
        [HttpGet("playlists")]
        public IActionResult Playlists([FromQuery] string? coub)
        {
            var playlists = _playlists.ReadSummaries(coub)
                .Select((p, index) => new { p.Name, p.Count, p.Order, p.Group, p.HasCoub, index })
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
                });

            return Ok(new { playlists, groupOrder = _groups.ReadPlaylistGroups() });
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
