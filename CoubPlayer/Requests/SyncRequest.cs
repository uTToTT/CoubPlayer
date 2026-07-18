namespace CoubPlayer.Requests
{
    public class SyncRequest
    {
        // "liked" или "bookmarks"
        public string Category { get; set; } = "";

        // remember_token из cookie авторизованной сессии coub.com
        public string Token { get; set; } = "";

        // Сколько роликов (от новых к старым) забрать за этот запуск
        public int Limit { get; set; } = 25;
    }
}