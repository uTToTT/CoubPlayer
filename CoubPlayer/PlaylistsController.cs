using CoubPlayer.Meta;
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

            // Сдвигаем order всех существующих видео на +1
            foreach (var video in pl.videos.Values)
            {
                video.order += 1;
            }

            // Добавляем новое видео в начало
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
                return NotFound($"Playlist '{playlist}' not found");

            if (!data[playlist].videos.ContainsKey(req.Id))
                return NotFound($"Video '{req.Id}' not found in playlist '{playlist}'");

            data[playlist].videos.Remove(req.Id);
            Save(data);

            return Ok();
        }

    }
}
