using CoubPlayer.Requests;
using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;

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
        private static readonly string[] Kinds = { "playlists", "tags" };

        private readonly GroupOrderRepository _groups;

        public GroupsController(GroupOrderRepository groups) => _groups = groups;

        [HttpGet("order")]
        public IActionResult GetOrder() => Ok(_groups.ReadAll());

        [HttpPost("order")]
        public IActionResult SetOrder([FromBody] SetGroupOrderRequest req)
        {
            if (req == null || !Kinds.Contains(req.Kind))
                return BadRequest("Kind must be 'playlists' or 'tags'");

            return Ok(_groups.SetOrder(req.Kind, req.Groups ?? new List<string>()));
        }
    }
}
