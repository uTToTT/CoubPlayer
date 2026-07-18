namespace CoubPlayer.Meta
{
    // Поля строчные — так же, как ожидает loader.js (coub_list.json грузится в JS as-is)
    public class CoubListEntry
    {
        public string id { get; set; } = "";
        public string video { get; set; } = "";
        public string audio { get; set; } = "";
        public List<string> tags { get; set; } = new();
    }
}