using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;

namespace CoubPlayer
{
    /// <summary>
    /// Версия плеера и состояние хранилища.
    ///
    /// Пригождается там, где иначе пришлось бы гадать: при разборе жалобы
    /// («какая у вас версия?»), при проверке, что обновление действительно
    /// встало, и клиенту — чтобы не считать, что сервер той же версии,
    /// что и открытая страница.
    /// </summary>
    [ApiController]
    [Route("api/version")]
    public class VersionController : ControllerBase
    {
        private readonly CoubDb _db;

        public VersionController(CoubDb db) => _db = db;

        [HttpGet]
        public IActionResult Get()
        {
            // Версия данных отличается от версии плеера ровно в одном случае:
            // плеер обновили, а он ещё не запускался и не мигрировал данные.
            // Видеть это полезно
            var dataVersion = _db.GetMeta(MetaKeys.AppVersion);

            return Ok(new
            {
                app = AppVersion.Current,
                schema = Schema.Version,
                data = dataVersion,
                importedAt = _db.GetMeta(MetaKeys.ImportedAt),
            });
        }
    }
}
