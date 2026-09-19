using CoubPlayer.Meta;
using CoubPlayer.Storage;
using Microsoft.AspNetCore.Mvc;

namespace CoubPlayer
{
    /// <summary>
    /// Пресеты постобработки — именованные наборы настроек, которые можно
    /// применить сразу к нескольким роликам. Лежат вместе с остальными данными,
    /// а не в localStorage, чтобы не потеряться вместе с данными браузера.
    /// </summary>
    [ApiController]
    [Route("api/fx-presets")]
    public class FxPresetsController : ControllerBase
    {
        private readonly FxPresetRepository _presets;

        public FxPresetsController(FxPresetRepository presets) => _presets = presets;

        [HttpGet]
        public IActionResult GetAll() => Ok(_presets.ReadAll());

        /// <summary>Создаёт пресет или перезаписывает существующий с тем же именем.</summary>
        [HttpPost]
        public IActionResult Save([FromBody] FxPreset preset)
        {
            if (string.IsNullOrWhiteSpace(preset?.name))
                return BadRequest("Preset name is required");

            preset.name = preset.name.Trim();
            return Ok(_presets.Save(preset));
        }

        [HttpDelete("{name}")]
        public IActionResult Delete([FromRoute] string name)
        {
            var remaining = _presets.Delete(name);
            return remaining == null ? NotFound() : Ok(remaining);
        }
    }
}
