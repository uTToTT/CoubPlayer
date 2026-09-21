using CoubPlayer.Services;
using Microsoft.AspNetCore.Mvc;

namespace CoubPlayer
{
    /// <summary>
    /// Файлы модели смыслового поиска: что уже скачано и загрузка недостающего.
    ///
    /// Сама модель работает в браузере — сервер её не запускает и запускать
    /// не умеет. Он только приносит файлы и отдаёт их со своего адреса,
    /// см. <see cref="ModelService"/>.
    /// </summary>
    [ApiController]
    [Route("api/models")]
    public class ModelsController : ControllerBase
    {
        private readonly ModelService _models;

        public ModelsController(ModelService models) => _models = models;

        [HttpGet("status")]
        public IActionResult Status() => Ok(_models.GetStatus());

        [HttpGet("progress")]
        public IActionResult Progress() => Ok(_models.Progress());

        [HttpPost("download")]
        public IActionResult Download() => Ok(_models.Start());

        [HttpPost("stop")]
        public IActionResult Stop() => Ok(_models.Stop());
    }
}
