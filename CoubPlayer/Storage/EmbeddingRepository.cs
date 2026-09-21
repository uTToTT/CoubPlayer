using System.Numerics;
using Microsoft.Data.Sqlite;

namespace CoubPlayer.Storage
{
    /// <summary>Ролик и то, насколько он подошёл запросу. 1 — в точку, 0 — мимо.</summary>
    public record Match(string Id, double Score);

    /// <summary>
    /// Векторы кадров — то, на чём стоит смысловой поиск.
    ///
    /// Идея целиком: модель переводит и кадр, и фразу в числа одного и того же
    /// пространства, и близость этих чисел означает близость по смыслу. Ни
    /// названий, ни тегов при этом не нужно — «кот прыгает» находит кота,
    /// даже если ролик называется «xd228».
    ///
    /// Считает векторы браузер (сервер не умеет ни декодировать mp4, ни
    /// запускать модель), здесь они только лежат и сравниваются.
    ///
    /// Как лежат: coubs.embedding — сырые float32 подряд, little-endian.
    /// Каждый вектор при записи приводится к единичной длине, поэтому
    /// косинус — это просто скалярное произведение, без делений на длины
    /// в горячем цикле.
    ///
    /// Почему перебором, а не индексом: восемь тысяч векторов по 768 чисел —
    /// это шесть миллионов умножений на запрос, то есть единицы миллисекунд.
    /// HNSW и прочее начинают окупаться на сотнях тысяч; здесь они добавили бы
    /// приблизительность и зависимость, не дав ничего взамен.
    /// </summary>
    public class EmbeddingRepository
    {
        private readonly CoubDb _db;
        private readonly object _lock = new();

        /// <summary>
        /// Все векторы в памяти — 8716 × 768 × 4 байта это 27 МБ, и читать их
        /// из базы на каждый запрос незачем. Сбрасывается при любой записи.
        /// </summary>
        private (string[] Ids, float[] Flat, int Dim)? _cache;

        public EmbeddingRepository(CoubDb db) => _db = db;

        // ─── Состояние индекса ──────────────────────────────────────────────

        public record Status(string? Model, int Dim, int Total, int Indexed);

        public Status ReadStatus()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                return new Status(
                    GetMeta(connection, MetaKeys.EmbeddingModel),
                    int.TryParse(GetMeta(connection, MetaKeys.EmbeddingDim), out var dim) ? dim : 0,
                    Count(connection, "SELECT COUNT(*) FROM coubs;"),
                    Count(connection, "SELECT COUNT(*) FROM coubs WHERE embedding IS NOT NULL;"));
            }
        }

        /// <summary>
        /// Ролики, которым вектора ещё нет. Порядок — как в библиотеке: индексация
        /// идёт пачками, и при обрыве продолжить надо с того же места.
        /// </summary>
        public List<string> ReadPending(int limit)
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT id FROM coubs WHERE embedding IS NULL ORDER BY rowid LIMIT $limit;";
                command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 5000));

                var ids = new List<string>();
                using var reader = command.ExecuteReader();
                while (reader.Read()) ids.Add(reader.GetString(0));
                return ids;
            }
        }

        // ─── Запись ─────────────────────────────────────────────────────────

        public enum SaveOutcome { Ok, ModelMismatch, BadVector }

        /// <summary>
        /// Кладёт посчитанные векторы.
        ///
        /// Модель проверяется на каждой пачке: перемешать в одной таблице числа
        /// от двух разных моделей — значит получить поиск, который иногда врёт
        /// и никогда об этом не сообщает. Первая пачка задаёт модель, дальше
        /// она должна совпадать, а сменить её можно только через Reset.
        /// </summary>
        public (SaveOutcome outcome, int saved, string? expected) Save(
            string model, int dim, IReadOnlyList<(string Id, float[] Vector)> items)
        {
            if (string.IsNullOrWhiteSpace(model) || dim <= 0) return (SaveOutcome.BadVector, 0, null);
            if (items.Any(i => i.Vector.Length != dim)) return (SaveOutcome.BadVector, 0, null);

            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                var storedModel = GetMeta(connection, MetaKeys.EmbeddingModel);
                if (storedModel == null)
                {
                    SetMeta(connection, transaction, MetaKeys.EmbeddingModel, model);
                    SetMeta(connection, transaction, MetaKeys.EmbeddingDim, dim.ToString());
                }
                else if (storedModel != model)
                {
                    return (SaveOutcome.ModelMismatch, 0, storedModel);
                }

                var saved = 0;
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText =
                        "UPDATE coubs SET embedding = $vec WHERE id = $id;";
                    var vec = command.Parameters.Add("$vec", SqliteType.Blob);
                    var id = command.Parameters.Add("$id", SqliteType.Text);

                    foreach (var item in items)
                    {
                        vec.Value = ToBlob(Normalize(item.Vector));
                        id.Value = item.Id;
                        saved += command.ExecuteNonQuery();
                    }
                }

                transaction.Commit();
                _cache = null;
                return (SaveOutcome.Ok, saved, null);
            }
        }

        /// <summary>
        /// Стирает индекс целиком. Нужен при смене модели: дописать поверх
        /// нельзя, старые числа надо именно убрать.
        /// </summary>
        public int Reset()
        {
            lock (_lock)
            {
                using var connection = _db.Open();
                using var transaction = connection.BeginTransaction();

                int cleared;
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE coubs SET embedding = NULL WHERE embedding IS NOT NULL;";
                    cleared = command.ExecuteNonQuery();
                }

                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "DELETE FROM meta WHERE key IN ($m, $d);";
                    command.Parameters.AddWithValue("$m", MetaKeys.EmbeddingModel);
                    command.Parameters.AddWithValue("$d", MetaKeys.EmbeddingDim);
                    command.ExecuteNonQuery();
                }

                transaction.Commit();
                _cache = null;
                return cleared;
            }
        }

        // ─── Поиск ──────────────────────────────────────────────────────────

        /// <summary>
        /// Вектор одного ролика — чтобы искать похожее на него, а не на фразу.
        /// null — ролик ещё не разобран.
        /// </summary>
        public float[]? ReadVector(string coubId)
        {
            var (ids, flat, dim) = LoadAll();
            var at = Array.IndexOf(ids, coubId);
            if (at < 0) return null;

            var vector = new float[dim];
            Array.Copy(flat, at * dim, vector, 0, dim);
            return vector;
        }

        /// <summary>
        /// Ближайшие к запросу ролики.
        ///
        /// <paramref name="within"/> — ограничить поиск этими роликами
        /// (в плеере это открытый плейлист). null — искать по всей библиотеке.
        /// </summary>
        public List<Match> Search(
            float[] query, int limit,
            IReadOnlySet<string>? within = null, string? exclude = null)
        {
            var (ids, flat, dim) = LoadAll();
            if (ids.Length == 0 || query.Length != dim) return new();

            var probe = Normalize(query);
            var best = new List<Match>();

            for (var i = 0; i < ids.Length; i++)
            {
                if (within != null && !within.Contains(ids[i])) continue;
                // Сам ролик — всегда свой ближайший сосед, и в ответе
                // «похожие на него» ему делать нечего
                if (exclude != null && ids[i] == exclude) continue;
                best.Add(new Match(ids[i], Dot(flat, i * dim, probe)));
            }

            return best
                .OrderByDescending(m => m.Score)
                .Take(Math.Clamp(limit, 1, 500))
                .ToList();
        }

        /// <summary>
        /// Скалярное произведение единичных векторов — он же косинус.
        /// Через Vector&lt;float&gt;: процессор считает по несколько чисел за такт,
        /// и на шести миллионах умножений это разница в разы.
        /// </summary>
        private static double Dot(float[] flat, int offset, float[] probe)
        {
            var step = Vector<float>.Count;
            var sum = Vector<float>.Zero;

            var i = 0;
            for (; i + step <= probe.Length; i += step)
            {
                sum += new Vector<float>(flat, offset + i) * new Vector<float>(probe, i);
            }

            double total = Vector.Dot(sum, Vector<float>.One);
            for (; i < probe.Length; i++) total += flat[offset + i] * probe[i];
            return total;
        }

        private (string[] Ids, float[] Flat, int Dim) LoadAll()
        {
            lock (_lock)
            {
                if (_cache.HasValue) return _cache.Value;

                using var connection = _db.Open();
                var dim = int.TryParse(GetMeta(connection, MetaKeys.EmbeddingDim), out var d) ? d : 0;
                if (dim <= 0) return (_cache = (Array.Empty<string>(), Array.Empty<float>(), 0)).Value;

                using var command = connection.CreateCommand();
                command.CommandText =
                    "SELECT id, embedding FROM coubs WHERE embedding IS NOT NULL ORDER BY rowid;";

                var ids = new List<string>();
                var flat = new List<float>();

                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var blob = (byte[])reader["embedding"];
                    // Длина не та — вектор писала другая модель или он побился.
                    // Молча пропускаем: один плохой ряд не повод ронять поиск
                    if (blob.Length != dim * sizeof(float)) continue;

                    ids.Add(reader.GetString(0));
                    for (var i = 0; i < dim; i++)
                        flat.Add(BitConverter.ToSingle(blob, i * sizeof(float)));
                }

                return (_cache = (ids.ToArray(), flat.ToArray(), dim)).Value;
            }
        }

        // ─── Мелочи ─────────────────────────────────────────────────────────

        /// <summary>
        /// К единичной длине. Делается один раз при записи, чтобы поиск был
        /// чистым умножением: делить на длины восемь тысяч раз за запрос —
        /// ровно та работа, которую можно не делать.
        /// </summary>
        private static float[] Normalize(float[] vector)
        {
            double sum = 0;
            foreach (var v in vector) sum += (double)v * v;

            var length = Math.Sqrt(sum);
            if (length < 1e-9) return vector; // нулевой вектор — оставляем как есть

            var result = new float[vector.Length];
            for (var i = 0; i < vector.Length; i++) result[i] = (float)(vector[i] / length);
            return result;
        }

        private static byte[] ToBlob(float[] vector)
        {
            var bytes = new byte[vector.Length * sizeof(float)];
            Buffer.BlockCopy(vector, 0, bytes, 0, bytes.Length);
            return bytes;
        }

        private static int Count(SqliteConnection cn, string sql)
        {
            using var command = cn.CreateCommand();
            command.CommandText = sql;
            return Convert.ToInt32(command.ExecuteScalar());
        }

        private static string? GetMeta(SqliteConnection cn, string key)
        {
            using var command = cn.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $k;";
            command.Parameters.AddWithValue("$k", key);
            return command.ExecuteScalar() as string;
        }

        private static void SetMeta(SqliteConnection cn, SqliteTransaction tx, string key, string value)
        {
            using var command = cn.CreateCommand();
            command.Transaction = tx;
            command.CommandText =
                "INSERT INTO meta (key, value) VALUES ($k, $v) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value;";
            command.Parameters.AddWithValue("$k", key);
            command.Parameters.AddWithValue("$v", value);
            command.ExecuteNonQuery();
        }
    }
}
