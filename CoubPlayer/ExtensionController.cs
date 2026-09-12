using CoubPlayer.Meta;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;

namespace CoubPlayer
{
    /// <summary>
    /// Точка входа для браузерного расширения.
    ///
    /// Расширение живёт на coub.com и умеет то, чего не может сервер, — ходить
    /// в приватный API от имени залогиненного пользователя. Скачиванием
    /// по-прежнему занимается сервер: расширение лишь присылает ссылки
    /// в /api/playlists/{playlist}/download.
    ///
    /// Здесь только то, что расширению нужно знать перед этим: жив ли сервер,
    /// куда складывать и что уже скачано.
    /// </summary>
    [ApiController]
    [Route("api/extension")]
    public class ExtensionController : ControllerBase
    {
        private readonly string _playlistsPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "playlists.json");

        private readonly string _coubListPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "coub_list.json");

        private readonly string _groupOrderPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "group_order.json");

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
                playlists = ReadPlaylistNames(),
            });
        }

        /// <summary>
        /// Что расширение вычитает из найденного в ленте, чтобы прислать только
        /// недостающее.
        ///
        /// С параметром playlist — id роликов именно в нём, и это то, что нужно
        /// при догрузке ленты: сверяться со всей библиотекой нельзя, иначе куб,
        /// скачанный когда-то в другой плейлист, в этот уже никогда не попадёт.
        /// Без параметра — вся библиотека.
        ///
        /// Ролик может лежать копией ("id#2"), поэтому отдаём базовые id.
        /// </summary>
        [HttpGet("library")]
        public IActionResult Library([FromQuery] string? playlist)
        {
            if (string.IsNullOrEmpty(playlist))
                return Ok(new { ids = ReadLibraryIds() });

            var data = ReadPlaylists();
            if (!data.TryGetValue(playlist, out var pl))
                return Ok(new { ids = new List<string>() });

            var ids = pl.videos?.Keys
                .Select(PlaylistKeys.BaseCoubId)
                .Distinct()
                .ToList() ?? new List<string>();

            return Ok(new { ids });
        }

        /// <summary>
        /// Плейлисты, которые пользователь привык видеть в плеере, для меню
        /// кнопки на coub.com.
        ///
        /// С параметром coub у каждого проставляется признак, лежит ли этот
        /// ролик уже в нём — чтобы в меню было видно, куда его добавлять смысла
        /// нет. Ролик может лежать копией ("id#2"), поэтому сверяем по базовому id.
        ///
        /// Рядом отдаётся порядок групп: раскладывает по ним уже расширение,
        /// но собирать это двумя запросами незачем.
        /// </summary>
        [HttpGet("playlists")]
        public IActionResult Playlists([FromQuery] string? coub)
        {
            var data = ReadPlaylists();

            var playlists = data
                .Select((pair, index) => new
                {
                    name = pair.Key,
                    count = pair.Value.videos?.Count ?? 0,
                    order = pair.Value.order,
                    group = pair.Value.group,
                    hasCoub = !string.IsNullOrEmpty(coub) &&
                              (pair.Value.videos?.Keys.Any(k => PlaylistKeys.BaseCoubId(k) == coub) ?? false),
                    index,
                })
                // Тот же порядок, что в плеере (sortPlaylistEntries в ui.js):
                // сперва расставленные перетаскиванием, затем привычные
                // bookmarks/liked, остальные — как лежат в файле
                .OrderBy(x => x.order ?? int.MaxValue)
                .ThenBy(x => x.order.HasValue ? 0 : PriorityRank(x.name))
                .ThenBy(x => x.index)
                .Select(x => new { x.name, x.count, x.order, x.group, x.hasCoub });

            return Ok(new { playlists, groupOrder = ReadGroupOrder() });
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

        /// <summary>Порядок групп плейлистов, заданный перетаскиванием в плеере.</summary>
        private List<string> ReadGroupOrder()
        {
            if (!System.IO.File.Exists(_groupOrderPath)) return new();
            try
            {
                var json = System.IO.File.ReadAllText(_groupOrderPath);
                var data = JsonConvert.DeserializeObject<Dictionary<string, List<string>>>(json);
                return data != null && data.TryGetValue("playlists", out var order) ? order : new();
            }
            catch (JsonException)
            {
                return new();
            }
        }

        private List<string> ReadPlaylistNames() => ReadPlaylists().Keys.ToList();

        private Dictionary<string, Playlist> ReadPlaylists()
        {
            if (!System.IO.File.Exists(_playlistsPath)) return new();
            try
            {
                var json = System.IO.File.ReadAllText(_playlistsPath);
                return JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json) ?? new();
            }
            catch (JsonException)
            {
                return new();
            }
        }

        private List<string> ReadLibraryIds()
        {
            if (!System.IO.File.Exists(_coubListPath)) return new();
            try
            {
                var json = System.IO.File.ReadAllText(_coubListPath);
                var list = JsonConvert.DeserializeObject<List<CoubListEntry>>(json);
                return list?.Select(x => x.id).Where(x => !string.IsNullOrEmpty(x)).ToList() ?? new();
            }
            catch (JsonException)
            {
                return new();
            }
        }
    }
}
