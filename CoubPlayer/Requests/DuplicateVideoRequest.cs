namespace CoubPlayer.Requests
{
    public class DuplicateVideoRequest
    {
        /// <summary>Ключ дублируемой записи в плейлисте (id куба или id#N для копии).</summary>
        public string Id { get; set; } = "";
    }
}
