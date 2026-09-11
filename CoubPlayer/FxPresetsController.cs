using CoubPlayer.Meta;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;

namespace CoubPlayer
{
    /// <summary>
    /// Пресеты постобработки — именованные наборы настроек, которые можно
    /// применить сразу к нескольким роликам. Лежат рядом с остальными данными,
    /// а не в localStorage, чтобы не потеряться вместе с данными браузера.
    /// </summary>
    [ApiController]
    [Route("api/fx-presets")]
    public class FxPresetsController : ControllerBase
    {
        private readonly string _path = Path.Combine(
            Directory.GetCurrentDirectory(), "wwwroot", "Data", "fx_presets.json");

        private static readonly object _lock = new();

        private List<FxPreset> ReadAllUnsafe()
        {
            if (!System.IO.File.Exists(_path)) return new List<FxPreset>();
            try
            {
                var json = System.IO.File.ReadAllText(_path);
                return JsonConvert.DeserializeObject<List<FxPreset>>(json) ?? new List<FxPreset>();
            }
            catch (JsonException)
            {
                // Битый файл — не повод падать: считаем, что пресетов нет
                return new List<FxPreset>();
            }
        }

        private void WriteAllUnsafe(List<FxPreset> presets)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            var json = JsonConvert.SerializeObject(presets, Formatting.Indented);
            var tempPath = _path + ".tmp";
            System.IO.File.WriteAllText(tempPath, json);

            if (System.IO.File.Exists(_path))
                System.IO.File.Replace(tempPath, _path, null);
            else
                System.IO.File.Move(tempPath, _path);
        }

        [HttpGet]
        public IActionResult GetAll()
        {
            lock (_lock) return Ok(ReadAllUnsafe());
        }

        /// <summary>Создаёт пресет или перезаписывает существующий с тем же именем.</summary>
        [HttpPost]
        public IActionResult Save([FromBody] FxPreset preset)
        {
            if (string.IsNullOrWhiteSpace(preset?.name))
                return BadRequest("Preset name is required");

            preset.name = preset.name.Trim();

            lock (_lock)
            {
                var presets = ReadAllUnsafe();
                var idx = presets.FindIndex(p =>
                    string.Equals(p.name, preset.name, StringComparison.OrdinalIgnoreCase));

                if (idx >= 0) presets[idx] = preset;
                else presets.Add(preset);

                WriteAllUnsafe(presets);
                return Ok(presets);
            }
        }

        [HttpDelete("{name}")]
        public IActionResult Delete([FromRoute] string name)
        {
            lock (_lock)
            {
                var presets = ReadAllUnsafe();
                var removed = presets.RemoveAll(p =>
                    string.Equals(p.name, name, StringComparison.OrdinalIgnoreCase));

                if (removed == 0) return NotFound();

                WriteAllUnsafe(presets);
                return Ok(presets);
            }
        }
    }
}
