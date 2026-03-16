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
            return Ok(Load());
        }

        [HttpPost]
        public IActionResult Create([FromBody] CreatePlaylistRequest req)
        {
            var name = req.Name;
            var data = Load();

            if (data.ContainsKey(name))
                return BadRequest("Playlist exists");

            data[name] = new Playlist
            {
                title = name,
                videos = new Dictionary<string, VideoMeta>()
            };

            Save(data);

            return Ok();
        }

        [HttpPost("{playlist}/add")]
        public IActionResult AddVideo([FromRoute] string playlist, [FromBody] AddVideoRequest req)
        {
            var data = Load();

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

            Save(data);

            return Ok();
        }


        [HttpPost("{playlist}/remove")]
        public IActionResult RemoveVideo([FromRoute] string playlist, [FromBody] RemoveVideoRequest req)
        {
            var data = Load();

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

            Save(data);

            return Ok();
        }

        [HttpPost("{playlist}/viewed")]
        public IActionResult MarkViewed([FromRoute] string playlist, [FromBody] ViewVideoRequest req)
        {
            var data = Load();

            if (!data.ContainsKey(playlist))
                return NotFound();

            var pl = data[playlist];

            if (!pl.videos.ContainsKey(req.id))
                return NotFound();

            pl.videos[req.id].lastViewed = DateTime.UtcNow;

            Save(data);

            return Ok();
        }
    }
}
