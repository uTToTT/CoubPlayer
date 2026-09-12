using CoubPlayer.Requests;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;

namespace CoubPlayer
{
    /// <summary>
    /// Порядок групп в списках плейлистов и тегов.
    ///
    /// Группы не заводятся отдельно — они существуют, пока на них кто-то
    /// ссылается. Поэтому здесь хранится только их последовательность:
    /// названные идут в этом порядке, остальные — после, по алфавиту.
    /// </summary>
    [ApiController]
    [Route("api/groups")]
    public class GroupsController : ControllerBase
    {
        private readonly string _path = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "group_order.json");

        private static readonly object _lock = new();

        private static readonly string[] Kinds = { "playlists", "tags" };

        private Dictionary<string, List<string>> ReadUnsafe()
        {
            if (!System.IO.File.Exists(_path)) return new();
            try
            {
                var json = System.IO.File.ReadAllText(_path);
                return JsonConvert.DeserializeObject<Dictionary<string, List<string>>>(json) ?? new();
            }
            catch (JsonException)
            {
                return new();
            }
        }

        private void WriteUnsafe(Dictionary<string, List<string>> data)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            var json = JsonConvert.SerializeObject(data, Formatting.Indented);
            var tempPath = _path + ".tmp";
            System.IO.File.WriteAllText(tempPath, json);

            if (System.IO.File.Exists(_path))
                System.IO.File.Replace(tempPath, _path, null);
            else
                System.IO.File.Move(tempPath, _path);
        }

        [HttpGet("order")]
        public IActionResult GetOrder()
        {
            lock (_lock) return Ok(ReadUnsafe());
        }

        [HttpPost("order")]
        public IActionResult SetOrder([FromBody] SetGroupOrderRequest req)
        {
            if (req == null || !Kinds.Contains(req.Kind))
                return BadRequest("Kind must be 'playlists' or 'tags'");

            lock (_lock)
            {
                var data = ReadUnsafe();
                data[req.Kind] = req.Groups ?? new List<string>();
                WriteUnsafe(data);
                return Ok(data);
            }
        }
    }
}
