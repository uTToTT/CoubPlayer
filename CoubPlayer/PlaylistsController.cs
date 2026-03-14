using CoubPlayer.Meta;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;

namespace CoubPlayer
{
    [ApiController]
    [Route("api/playlists")]
    public class PlaylistsController : ControllerBase
    {
        private readonly string _path = "playlists.json";

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
        public IActionResult Create([FromBody] string name)
        {
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
        public IActionResult AddVideo(string playlist, [FromBody] AddVideoRequest req)
        {
            var data = Load();

            if (!data.ContainsKey(playlist))
                return NotFound();

            data[playlist].videos[req.id] = new VideoMeta
            {
                title = req.title,
                order = data[playlist].videos.Count
            };

            Save(data);

            return Ok();
        }

        [HttpPost("{playlist}/remove")]
        public IActionResult RemoveVideo(string playlist, [FromBody] string id)
        {
            var data = Load();

            if (!data.ContainsKey(playlist))
                return NotFound();

            data[playlist].videos.Remove(id);

            Save(data);

            return Ok();
        }
    }
}
