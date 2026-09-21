using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;

namespace CoubPlayer
{
    /// <summary>
    /// Смысловой поиск: индекс векторов кадров и поиск по нему.
    ///
    /// Считает векторы браузер — он единственный здесь, кто умеет и
    /// декодировать mp4, и запускать модель на видеокарте. Сервер их принимает,
    /// хранит и сравнивает; см. <see cref="EmbeddingRepository"/>.
    ///
    /// Поэтому здесь нет ни одной операции «посчитай»: только «прими»,
    /// «отдай, чего не хватает» и «найди ближайшее».
    /// </summary>
    [ApiController]
    [Route("api/embeddings")]
    public class EmbeddingsController : ControllerBase
    {
        private readonly EmbeddingRepository _embeddings;
        private readonly PlaylistRepository _playlists;

        public EmbeddingsController(EmbeddingRepository embeddings, PlaylistRepository playlists)
        {
            _embeddings = embeddings;
            _playlists = playlists;
        }

        public class SaveRequest
        {
            /// <summary>Чем считали — например «siglip2-base-patch16-256/q4f16».</summary>
            public string? Model { get; set; }
            public int Dim { get; set; }
            public List<Item> Items { get; set; } = new();

            public class Item
            {
                public string? Id { get; set; }
                public float[]? Vector { get; set; }
            }
        }

        public class SearchRequest
        {
            public float[]? Vector { get; set; }
            public int Limit { get; set; } = 60;

            /// <summary>Искать только внутри этого плейлиста. Пусто — по всей библиотеке.</summary>
            public string? Playlist { get; set; }

            /// <summary>
            /// Искать только среди этих роликов. Нужен там, где на экране не
            /// плейлист целиком, а уже отобранное: сетка показывает то, что
            /// отфильтровано по тегам, и искать вне этого набора бессмысленно.
            /// Задан вместе с Playlist — берётся он.
            /// </summary>
            public List<string>? Ids { get; set; }
        }

        /// <summary>Сколько роликов уже разобрано и чем.</summary>
        [HttpGet("status")]
        public IActionResult Status()
        {
            var s = _embeddings.ReadStatus();
            return Ok(new
            {
                model = s.Model,
                dim = s.Dim,
                total = s.Total,
                indexed = s.Indexed,
                pending = s.Total - s.Indexed,
            });
        }

        /// <summary>Ролики без вектора — очередь для индексации.</summary>
        [HttpGet("pending")]
        public IActionResult Pending([FromQuery] int limit = 200)
        {
            return Ok(new { ids = _embeddings.ReadPending(limit) });
        }

        [HttpPost]
        public IActionResult Save([FromBody] SaveRequest req)
        {
            if (req == null || string.IsNullOrWhiteSpace(req.Model) || req.Dim <= 0)
                return BadRequest("Не указана модель или длина вектора");

            var items = new List<(string, float[])>();
            foreach (var item in req.Items)
            {
                if (string.IsNullOrEmpty(item.Id) || item.Vector == null)
                    return BadRequest("В пачке есть запись без id или без вектора");
                items.Add((item.Id, item.Vector));
            }

            var (outcome, saved, expected) = _embeddings.Save(req.Model!, req.Dim, items);

            return outcome switch
            {
                EmbeddingRepository.SaveOutcome.Ok => Ok(new { saved }),
                EmbeddingRepository.SaveOutcome.ModelMismatch => Conflict(
                    $"Индекс построен моделью «{expected}». Сначала сбросьте его, " +
                    "иначе в одной таблице окажутся несравнимые числа."),
                _ => BadRequest($"Вектор не длины {req.Dim}"),
            };
        }

        /// <summary>Ближайшие к запросу ролики. Вектор запроса считает браузер.</summary>
        [HttpPost("search")]
        public IActionResult Search([FromBody] SearchRequest req)
        {
            if (req?.Vector == null || req.Vector.Length == 0)
                return BadRequest("Пустой вектор запроса");

            IReadOnlySet<string>? within = null;
            if (req.Ids is { Count: > 0 }) within = req.Ids.ToHashSet();
            else if (!string.IsNullOrEmpty(req.Playlist))
                within = _playlists.ReadCoubIds(req.Playlist).ToHashSet();

            var results = _embeddings.Search(req.Vector, req.Limit, within);
            return Ok(new { results = results.Select(r => new { id = r.Id, score = r.Score }) });
        }

        public class SimilarRequest
        {
            public string? Id { get; set; }
            public int Limit { get; set; } = 60;

            /// <summary>Искать только среди этих роликов. Пусто — по всей библиотеке.</summary>
            public List<string>? Ids { get; set; }
        }

        /// <summary>
        /// Ролики, похожие на этот.
        ///
        /// То же сравнение векторов, что и при поиске фразой, только вектор
        /// берётся не у запроса, а у самого ролика — считать заново ничего
        /// не надо, он уже лежит в базе. Поэтому и модель для этого не нужна:
        /// работает даже там, где текстовую башню не скачивали.
        /// </summary>
        [HttpPost("similar")]
        public IActionResult Similar([FromBody] SimilarRequest req)
        {
            if (string.IsNullOrEmpty(req?.Id)) return BadRequest("Не указан ролик");

            var vector = _embeddings.ReadVector(req.Id!);
            if (vector == null)
                return Ok(new { results = Array.Empty<object>(), indexed = false });

            IReadOnlySet<string>? within = req.Ids is { Count: > 0 } ? req.Ids.ToHashSet() : null;
            var results = _embeddings.Search(vector, req.Limit, within, exclude: req.Id);

            return Ok(new
            {
                results = results.Select(r => new { id = r.Id, score = r.Score }),
                indexed = true,
            });
        }

        /// <summary>Стереть индекс — нужно при смене модели.</summary>
        [HttpDelete]
        public IActionResult Reset() => Ok(new { cleared = _embeddings.Reset() });
    }
}
