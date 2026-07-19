using CoubPlayer.Meta;
using CoubPlayer.Services;
using Microsoft.AspNetCore.Mvc;
using System.Diagnostics;

[ApiController]
[Route("api/coubs")]
public class CoubsController : ControllerBase
{
    private readonly CoubListService _coubListService;
    public CoubsController(CoubListService coubListService) => _coubListService = coubListService;

    [HttpGet("tags")]
    public IActionResult GetAllTags() =>
        Ok(_coubListService.GetAllTags().Select(x => new { tag = x.Tag, count = x.Count }));

    [HttpGet("{id}/tags")]
    public IActionResult GetTags(string id)
    {
        var tags = _coubListService.GetTags(id);
        return tags == null ? NotFound() : Ok(tags);
    }

    [HttpPost("{id}/tags")]
    public IActionResult AddTag(string id, [FromBody] TagRequest req)
    {
        var tags = _coubListService.AddTag(id, req.Tag);
        return tags == null ? NotFound() : Ok(tags);
    }

    [HttpDelete("{id}/tags/{tag}")]
    public IActionResult RemoveTag(string id, string tag)
    {
        var tags = _coubListService.RemoveTag(id, tag);
        return tags == null ? NotFound() : Ok(tags);
    }

    // GET /api/coubs/search?tags=funny,cats&mode=any|all
    [HttpGet("search")]
    public IActionResult Search([FromQuery] string tags, [FromQuery] string mode = "any")
    {
        if (string.IsNullOrWhiteSpace(tags)) return Ok(new List<CoubListEntry>());
        var wanted = tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return Ok(_coubListService.Search(wanted, mode));
    }

    public class RenameTagRequest { public string NewName { get; set; } }

    // POST /api/coubs/tags/{tag}/rename
    [HttpPost("tags/{tag}/rename")]
    public IActionResult RenameTagGlobally(string tag, [FromBody] RenameTagRequest req)
    {
        if (string.IsNullOrWhiteSpace(req?.NewName))
            return BadRequest("newName не указан");

        var count = _coubListService.RenameTagGlobally(tag, req.NewName);
        return count == 0 ? NotFound() : Ok(new { renamed = count });
    }

    // DELETE /api/coubs/tags/{tag}
    [HttpDelete("tags/{tag}")]
    public IActionResult DeleteTagGlobally(string tag)
    {
        var count = _coubListService.DeleteTagGlobally(tag);
        return count == 0 ? NotFound() : Ok(new { removed = count });
    }

    // DELETE /api/coubs/tags
    [HttpDelete("tags")]
    public IActionResult DeleteAllTags()
    {
        var count = _coubListService.DeleteAllTags();
        return Ok(new { removed = count });
    }

    /// <summary>
    /// Открывает папку с файлами ролика (video.mp4 / audio.*) в проводнике ОС,
    /// на которой запущен сервер. Работает только когда сервер и клиент — одна
    /// и та же машина (локальный плеер на localhost), в противном случае
    /// откроет проводник не у того, кто нажал кнопку.
    /// </summary>
    [HttpPost("{id}/open-folder")]
    public IActionResult OpenFolder([FromRoute] string id)
    {
        var folder = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "Coubs", id);

        if (!Directory.Exists(folder))
            return NotFound("Папка ролика не найдена");

        try
        {
            if (OperatingSystem.IsWindows())
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = $"\"{folder}\"",
                    UseShellExecute = true,
                });
            }
            else if (OperatingSystem.IsMacOS())
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "open",
                    Arguments = $"\"{folder}\"",
                    UseShellExecute = true,
                });
            }
            else if (OperatingSystem.IsLinux())
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "xdg-open",
                    Arguments = $"\"{folder}\"",
                    UseShellExecute = true,
                });
            }
            else
            {
                return StatusCode(501, "Открытие папки не поддерживается на этой ОС");
            }

            return Ok();
        }
        catch (Exception ex)
        {
            return StatusCode(500, $"Не удалось открыть папку: {ex.Message}");
        }
    }
}

public class TagRequest { public string Tag { get; set; } }