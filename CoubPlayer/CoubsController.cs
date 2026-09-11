using CoubPlayer.Meta;
using CoubPlayer.Requests;
using CoubPlayer.Services;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using System.Diagnostics;

[ApiController]
[Route("api/coubs")]
public class CoubsController : ControllerBase
{
    private readonly CoubListService _coubListService;
    public CoubsController(CoubListService coubListService) => _coubListService = coubListService;

    #region Tag groups

    // Теги — это просто строки в coub_list.json, вешать на них поле некуда,
    // поэтому принадлежность к группе хранится отдельной картой «тег → группа».
    private readonly string _tagGroupsPath = Path.Combine(
        Directory.GetCurrentDirectory(), "wwwroot", "Data", "tag_groups.json");

    private static readonly object _tagGroupsLock = new();

    private Dictionary<string, string> ReadTagGroupsUnsafe()
    {
        if (!System.IO.File.Exists(_tagGroupsPath)) return new();
        try
        {
            var json = System.IO.File.ReadAllText(_tagGroupsPath);
            return JsonConvert.DeserializeObject<Dictionary<string, string>>(json) ?? new();
        }
        catch (JsonException)
        {
            return new();
        }
    }

    private void WriteTagGroupsUnsafe(Dictionary<string, string> map)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_tagGroupsPath)!);

        var json = JsonConvert.SerializeObject(map, Formatting.Indented);
        var tempPath = _tagGroupsPath + ".tmp";
        System.IO.File.WriteAllText(tempPath, json);

        if (System.IO.File.Exists(_tagGroupsPath))
            System.IO.File.Replace(tempPath, _tagGroupsPath, null);
        else
            System.IO.File.Move(tempPath, _tagGroupsPath);
    }

    [HttpGet("tag-groups")]
    public IActionResult GetTagGroups()
    {
        lock (_tagGroupsLock) return Ok(ReadTagGroupsUnsafe());
    }

    /// <summary>Собирает тег в группу (пустое имя — убрать из группы).</summary>
    [HttpPost("tag-groups")]
    public IActionResult SetTagGroup([FromBody] SetGroupRequest req)
    {
        if (string.IsNullOrWhiteSpace(req?.Tag))
            return BadRequest("Tag is required");

        lock (_tagGroupsLock)
        {
            var map = ReadTagGroupsUnsafe();
            var group = req.Group?.Trim();

            if (string.IsNullOrEmpty(group)) map.Remove(req.Tag);
            else map[req.Tag] = group;

            WriteTagGroupsUnsafe(map);
            return Ok(map);
        }
    }

    #endregion

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
        if (count == 0) return NotFound();

        // Карта групп ключуется именем тега — переносим запись за ним
        lock (_tagGroupsLock)
        {
            var map = ReadTagGroupsUnsafe();
            if (map.Remove(tag, out var group))
            {
                map[req.NewName.Trim()] = group;
                WriteTagGroupsUnsafe(map);
            }
        }

        return Ok(new { renamed = count });
    }

    // DELETE /api/coubs/tags/{tag}
    [HttpDelete("tags/{tag}")]
    public IActionResult DeleteTagGlobally(string tag)
    {
        var count = _coubListService.DeleteTagGlobally(tag);
        if (count == 0) return NotFound();

        lock (_tagGroupsLock)
        {
            var map = ReadTagGroupsUnsafe();
            if (map.Remove(tag)) WriteTagGroupsUnsafe(map);
        }

        return Ok(new { removed = count });
    }

    // DELETE /api/coubs/tags
    [HttpDelete("tags")]
    public IActionResult DeleteAllTags()
    {
        var count = _coubListService.DeleteAllTags();

        lock (_tagGroupsLock) WriteTagGroupsUnsafe(new());

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