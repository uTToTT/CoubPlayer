using CoubPlayer.Meta;
using CoubPlayer.Requests;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;

namespace CoubPlayer
{
    [ApiController]
    [Route("api/playlists")]
    public class PlaylistsController : ControllerBase
    {
        private readonly string _path = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "playlists.json");

        private static readonly object _lock = new();

        private IActionResult ExecuteLocked(Func<Dictionary<string, Playlist>, IActionResult> action)
        {
            lock (_lock)
            {
                var json = System.IO.File.ReadAllText(_path);
                var data = JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json);

                var result = action(data);

                var newJson = JsonConvert.SerializeObject(data, Formatting.Indented);
                var tempPath = _path + ".tmp";
                System.IO.File.WriteAllText(tempPath, newJson);
                System.IO.File.Replace(tempPath, _path, null);

                return result;
            }
        }

        private Dictionary<string, Playlist> Load()
        {
            var json = System.IO.File.ReadAllText(_path);
            return JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json);
        }

        private void Save(Dictionary<string, Playlist> data)
        {
            var json = JsonConvert.SerializeObject(data, Formatting.Indented);
            System.IO.File.WriteAllText(_path, json);
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
                var name = req.Name;

                if (data.ContainsKey(name))
                    return BadRequest("Playlist exists");

                data[name] = new Playlist
                {
                    title = name,
                    videos = new Dictionary<string, VideoMeta>()
                };

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
                {
                    video.order += 1;
                }

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
    }
}
