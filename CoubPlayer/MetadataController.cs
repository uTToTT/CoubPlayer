using CoubPlayer.Services;
using Microsoft.AspNetCore.Mvc;

namespace CoubPlayer
{
    /// <summary>
    /// Дозагрузка сведений о роликах от Coub — см. <see cref="MetadataService"/>.
    /// </summary>
    [ApiController]
    [Route("api/metadata")]
    public class MetadataController : ControllerBase
    {
        private readonly MetadataService _metadata;
        private readonly RestoreService _restore;

        public MetadataController(MetadataService metadata, RestoreService restore)
        {
            _metadata = metadata;
            _restore = restore;
        }

        [HttpGet("status")]
        public IActionResult Status() => Ok(_metadata.GetStatus());

        /// <summary>Сколько роликов ещё без сведений.</summary>
        [HttpGet("pending")]
        public IActionResult Pending() => Ok(new { pending = _metadata.CountPending() });

        [HttpPost("start")]
        public IActionResult Start()
        {
            if (_metadata.GetStatus().running)
                return Conflict("Дозагрузка уже идёт");

            // Обе задачи ходят на coub.com с выдержанными паузами. Запущенные
            // разом, они удваивают частоту запросов — и сайт отвечает 403 обеим
            if (_restore.GetStatus().running)
                return Conflict("Сейчас идёт возврат пропавших файлов — дождитесь его конца");

            return Ok(_metadata.Start());
        }

        [HttpPost("stop")]
        public IActionResult Stop() => Ok(_metadata.Stop());
    }
}
