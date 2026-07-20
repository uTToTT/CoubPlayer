namespace CoubPlayer.Services
{
    /// <summary>
    /// Небольшой хелпер для читаемого консольного вывода: секции, разделители, цвета.
    /// Работа с Console.ForegroundColor обёрнута в lock, т.к. это глобальное
    /// состояние консоли, а синки разных плейлистов могут идти параллельно.
    /// </summary>
    public static class ConsoleLog
    {
        private static readonly object _lock = new();

        public static void Section(string title)
        {
            lock (_lock)
            {
                var line = new string('═', Math.Max(12, title.Length + 4));
                Console.ForegroundColor = ConsoleColor.DarkCyan;
                Console.WriteLine();
                Console.WriteLine(line);
                Console.ForegroundColor = ConsoleColor.Cyan;
                Console.WriteLine($"▶ {title}");
                Console.ForegroundColor = ConsoleColor.DarkCyan;
                Console.WriteLine(line);
                Console.ResetColor();
            }
        }

        public static void Divider()
        {
            lock (_lock)
            {
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine(new string('─', 60));
                Console.ResetColor();
            }
        }

        public static void Info(string message) => Write(message, ConsoleColor.Gray);
        public static void Page(string message) => Write(message, ConsoleColor.White);
        public static void Success(string message) => Write("✔ " + message, ConsoleColor.Green);
        public static void Warn(string message) => Write("⚠ " + message, ConsoleColor.Yellow);
        public static void Error(string message) => Write("✘ " + message, ConsoleColor.Red);
        public static void Muted(string message) => Write(message, ConsoleColor.DarkGray);

        private static void Write(string message, ConsoleColor color)
        {
            lock (_lock)
            {
                Console.ForegroundColor = color;
                Console.WriteLine(message);
                Console.ResetColor();
            }
        }
    }
}