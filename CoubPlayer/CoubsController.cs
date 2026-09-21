using CoubPlayer.Meta;
using CoubPlayer.Requests;
using CoubPlayer.Services;
using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;
using System.Diagnostics;

[ApiController]
[Route("api/coubs")]
public class CoubsController : ControllerBase
{
    private readonly CoubRepository _coubs;
    private readonly SuggestionRepository _suggestions;

    public CoubsController(CoubRepository coubs, SuggestionRepository suggestions)
    {
        _coubs = coubs;
        _suggestions = suggestions;
    }

    /// <summary>
    /// Куда этот ролик скорее всего просится и какие свои теги ему подойдут.
    /// Считается по тегам, которые Coub повесил сам, — см. SuggestionRepository.
    /// Пусто — сведений о ролике ещё нет либо не на что опереться.
    /// </summary>
    [HttpGet("{id}/suggest")]
    public IActionResult Suggest(string id)
    {
        var (playlists, tags) = _suggestions.Suggest(id);
        return Ok(new { playlists, tags });
    }

    /// <summary>
    /// Вся библиотека: по ней плеер находит файлы ролика. Раньше клиент читал
    /// этот список прямо из Data/coub_list.json — теперь файла нет, данные
    /// живут в базе, и отдаются они отсюда.
    /// </summary>
    [HttpGet("list")]
    public IActionResult List() => Ok(_coubs.ReadAll());

    /// <summary>
    /// Авторы роликов: канал → id его роликов. Плеер ищет по ним в режиме
    /// плитки.
    ///
    /// Отдельно от /list намеренно. Тот список выгружается в coub_list.json
    /// при резервном копировании и сверяется с исходником при переходе с JSON;
    /// новое поле в нём изменило бы форму файла, который проверяется на
    /// точное совпадение. Сведения о ролике в JSON и так не попадают — они
    /// целиком в снимке базы.
    /// </summary>
    [HttpGet("channels")]
    public IActionResult Channels() => Ok(new { channels = _coubs.ReadChannels() });

    #region Thumbs

    // Кадр-превью ролика. Берётся не с сервера: декодировать mp4 ему нечем,
    // ffmpeg в зависимостях нет. Кадр снимает браузер, когда всё равно грузит
    // видео для баннера, и присылает сюда — со второго раза список плейлистов
    // обходится картинками по 10 КБ вместо десятков мегабайт видео.
    private static readonly string ThumbsPath = Path.Combine(
        Directory.GetCurrentDirectory(), "wwwroot", "Data", "thumbs");

    private const long MaxThumbBytes = 512 * 1024;

    /// <summary>Для каких роликов кадр уже снят.</summary>
    [HttpGet("thumbs")]
    public IActionResult Thumbs()
    {
        if (!Directory.Exists(ThumbsPath)) return Ok(new { ids = Array.Empty<string>() });

        var ids = Directory
            .EnumerateFiles(ThumbsPath, "*.webp")
            .Select(Path.GetFileNameWithoutExtension)
            .Where(n => !string.IsNullOrEmpty(n))
            .ToList();

        return Ok(new { ids });
    }

    /// <summary>
    /// Принимает снятый браузером кадр. Уже имеющийся не перезаписываем:
    /// кадр один и тот же, а гонять его повторно незачем.
    /// </summary>
    [HttpPost("{id}/thumb")]
    [RequestSizeLimit(MaxThumbBytes)]
    public async Task<IActionResult> SaveThumb([FromRoute] string id, IFormFile file)
    {
        if (!CoubDownloadService.IsSafeId(id))
            return BadRequest("Некорректный id ролика");

        if (file == null || file.Length == 0 || file.Length > MaxThumbBytes)
            return BadRequest("Пустой или слишком большой кадр");

        Directory.CreateDirectory(ThumbsPath);
        var path = Path.Combine(ThumbsPath, $"{id}.webp");

        if (System.IO.File.Exists(path)) return Ok(new { url = ThumbUrl(id) });

        // Через временный файл: оборванная заливка иначе оставила бы
        // обрезанную картинку, которую потом никто не перезапишет
        var temp = path + ".part";
        await using (var output = System.IO.File.Create(temp))
            await file.CopyToAsync(output);

        System.IO.File.Move(temp, path, overwrite: true);
        return Ok(new { url = ThumbUrl(id) });
    }

    private static string ThumbUrl(string id) => $"/Data/thumbs/{id}.webp";

    #endregion

    #region Tag groups

    [HttpGet("tag-groups")]
    public IActionResult GetTagGroups() => Ok(_coubs.GetTagGroups());

    /// <summary>Собирает тег в группу (пустое имя — убрать из группы).</summary>
    [HttpPost("tag-groups")]
    public IActionResult SetTagGroup([FromBody] SetGroupRequest req)
    {
        if (string.IsNullOrWhiteSpace(req?.Tag))
            return BadRequest("Tag is required");

        return Ok(_coubs.SetTagGroup(req.Tag, req.Group?.Trim()));
    }

    #endregion

    [HttpGet("tags")]
    public IActionResult GetAllTags() =>
        Ok(_coubs.GetAllTags().Select(x => new { tag = x.Tag, count = x.Count }));

    /// <summary>
    /// Что известно о ролике: канал, длительность, размер кадра, теги сайта.
    /// Заполняется дозагрузкой метаданных — см. MetadataService.
    /// </summary>
    [HttpGet("{id}/meta")]
    public IActionResult Meta(string id)
    {
        var meta = _coubs.ReadMetadata(id);
        return meta == null ? NotFound() : Ok(meta);
    }

    [HttpGet("{id}/tags")]
    public IActionResult GetTags(string id)
    {
        var tags = _coubs.GetTags(id);
        return tags == null ? NotFound() : Ok(tags);
    }

    [HttpPost("{id}/tags")]
    public IActionResult AddTag(string id, [FromBody] TagRequest req)
    {
        var tags = _coubs.AddTag(id, req.Tag);
        return tags == null ? NotFound() : Ok(tags);
    }

    [HttpDelete("{id}/tags/{tag}")]
    public IActionResult RemoveTag(string id, string tag)
    {
        var tags = _coubs.RemoveTag(id, tag);
        return tags == null ? NotFound() : Ok(tags);
    }

    // GET /api/coubs/search?tags=funny,cats&mode=any|all
    [HttpGet("search")]
    public IActionResult Search([FromQuery] string tags, [FromQuery] string mode = "any")
    {
        if (string.IsNullOrWhiteSpace(tags)) return Ok(new List<CoubListEntry>());
        var wanted = tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return Ok(_coubs.Search(wanted, mode));
    }

    public class RenameTagRequest { public string NewName { get; set; } }

    // POST /api/coubs/tags/{tag}/rename
    [HttpPost("tags/{tag}/rename")]
    public IActionResult RenameTagGlobally(string tag, [FromBody] RenameTagRequest req)
    {
        if (string.IsNullOrWhiteSpace(req?.NewName))
            return BadRequest("newName не указан");

        // Группа переезжает за тегом внутри самой операции: имя тега — её ключ
        var count = _coubs.RenameTagGlobally(tag, req.NewName);
        return count == 0 ? NotFound() : Ok(new { renamed = count });
    }

    // DELETE /api/coubs/tags/{tag}
    [HttpDelete("tags/{tag}")]
    public IActionResult DeleteTagGlobally(string tag)
    {
        var count = _coubs.DeleteTagGlobally(tag);
        return count == 0 ? NotFound() : Ok(new { removed = count });
    }

    // DELETE /api/coubs/tags
    [HttpDelete("tags")]
    public IActionResult DeleteAllTags() => Ok(new { removed = _coubs.DeleteAllTags() });

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
