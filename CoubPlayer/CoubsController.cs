using CoubPlayer.Meta;
using CoubPlayer.Services;
using Microsoft.AspNetCore.Mvc;

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
}

public class TagRequest { public string Tag { get; set; } }