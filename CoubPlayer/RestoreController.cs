using CoubPlayer.Services;
using Microsoft.AspNetCore.Mvc;

namespace CoubPlayer
{
    /// <summary>
    /// Докачка роликов, которые числятся в библиотеке, но пропали с диска.
    /// Плейлисты при этом не меняются — записи в них уже есть, не хватает
    /// только файлов.
    /// </summary>
    [ApiController]
    [Route("api/restore")]
    public class RestoreController : ControllerBase
    {
        private readonly RestoreService _restore;
        private readonly MetadataService _metadata;

        public RestoreController(RestoreService restore, MetadataService metadata)
        {
            _restore = restore;
            _metadata = metadata;
        }

        /// <summary>
        /// Сколько роликов не хватает. Проверка ходит по диску, поэтому на
        /// большой библиотеке занимает секунду-другую — дёргать её на каждый
        /// чих не стоит.
        /// </summary>
        [HttpGet("missing")]
        public IActionResult Missing([FromQuery] bool ids = false)
        {
            var missing = _restore.FindMissing();
            return Ok(new
            {
                missing = missing.Count,
                ids = ids ? missing : null,
            });
        }

        [HttpPost("start")]
        public IActionResult Start()
        {
            var status = _restore.GetStatus();
            if (status.running) return Conflict("Восстановление уже идёт");

            // Обе задачи ходят на coub.com с выдержанными паузами. Запущенные
            // разом, они удваивают частоту запросов — и сайт отвечает 403 обеим
            if (_metadata.GetStatus().running)
                return Conflict("Сейчас идёт дозагрузка метаданных — дождитесь её конца");

            return Ok(_restore.Start());
        }

        [HttpGet("status")]
        public IActionResult Status() => Ok(_restore.GetStatus());

        [HttpPost("stop")]
        public IActionResult Stop() => Ok(_restore.Stop());

        /// <summary>
        /// Итог последнего прохода: какие ролики удалены с coub.com и потому
        /// потеряны насовсем, а какие просто не дались и стоит повторить.
        /// Лежит на диске, поэтому переживает перезапуск приложения.
        /// </summary>
        [HttpGet("report")]
        public IActionResult Report()
        {
            var report = _restore.ReadReport();
            return report == null ? NotFound("Восстановление ещё не запускали") : Ok(report);
        }
    }
}
