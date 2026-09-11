namespace CoubPlayer.Requests
{
    public class ReorderPlaylistRequest
    {
        /// <summary>
        /// Идентификаторы роликов в новом порядке. Может быть подмножеством
        /// плейлиста (например, когда в сетке включён поиск или фильтр по тегам) —
        /// тогда переставляются только они, между собой, по своим же позициям.
        /// </summary>
        public List<string> Ids { get; set; } = new();
    }
}
