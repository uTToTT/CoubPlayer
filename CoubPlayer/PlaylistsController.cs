using CoubPlayer.Meta;
using CoubPlayer.Requests;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using SkiaSharp;

namespace CoubPlayer
{
    [ApiController]
    [Route("api/playlists")]
    public class PlaylistsController : ControllerBase
    {
        private readonly string _path = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "playlists.json");

        private readonly string _iconsPath = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "icons");

        private static readonly object _lock = new();


        #region Icons

        [HttpPost("{playlist}/icon")]
        public  IActionResult SetIcon([FromRoute] string playlist, IFormFile file)
        {
            if (file == null || file.Length == 0)
                return BadRequest("No file");

            lock (_lock)
            {
                var json = System.IO.File.ReadAllText(_path);
                var data = JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json)!;
                if (!data.ContainsKey(playlist))
                    return NotFound();
            }

            Directory.CreateDirectory(_iconsPath);

            var iconPath = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");

            // Ресайз через SkiaSharp
            using var inputStream = file.OpenReadStream();
            using var original = SKBitmap.Decode(inputStream);

            const int SIZE = 64;
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

        private IActionResult ExecuteLocked(Func<Dictionary<string, Playlist>, IActionResult> action)
        {
            lock (_lock)
            {
                var json = System.IO.File.ReadAllText(_path);
                var data = JsonConvert.DeserializeObject<Dictionary<string, Playlist>>(json)!;

                var result = action(data);

                // Сохраняем только если операция успешна
                if (result is OkResult or OkObjectResult)
                {
                    var newJson = JsonConvert.SerializeObject(data, Formatting.Indented);
                    var tempPath = _path + ".tmp";
                    System.IO.File.WriteAllText(tempPath, newJson);
                    System.IO.File.Replace(tempPath, _path, null);
                }

                return result;
            }
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
                if (data.ContainsKey(req.Name))
                    return BadRequest("Playlist exists");

                data[req.Name] = new Playlist
                {
                    title = req.Name,
                    videos = new Dictionary<string, VideoMeta>()
                };

                return Ok();
            });
        }

        [HttpPost("{playlist}/delete")]
        public IActionResult Delete([FromRoute] string playlist)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                var iconPath = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");
                if (System.IO.File.Exists(iconPath))
                    System.IO.File.Delete(iconPath);

                data.Remove(playlist);
                return Ok();
            });
        }

        [HttpPost("{playlist}/rename")]
        public IActionResult Rename([FromRoute] string playlist, [FromBody] RenamePlaylistRequest req)
        {
            return ExecuteLocked(data =>
            {
                if (!data.ContainsKey(playlist))
                    return NotFound();

                if (data.ContainsKey(req.NewName))
                    return BadRequest("Playlist exists");

                var pl = data[playlist];
                pl.title = req.NewName;

                var oldIcon = Path.Combine(_iconsPath, $"{SanitizeFileName(playlist)}.webp");
                var newIcon = Path.Combine(_iconsPath, $"{SanitizeFileName(req.NewName)}.webp");
                if (System.IO.File.Exists(oldIcon))
                    System.IO.File.Move(oldIcon, newIcon, overwrite: true);

                data.Remove(playlist);
                data[req.NewName] = pl;

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
                    video.order += 1;

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