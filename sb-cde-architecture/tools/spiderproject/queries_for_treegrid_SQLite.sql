-- UPD 2.0: реальные запросы для works.sqlite текущего парсера (SQLite).
-- Для иной серверной БД используйте аналогичные поля и индексы.
-- !!! Не группировать по CBS/КФО/Spider_Code и не сортировать по WBS.

-- 1. Получить все исходные строки в правильном порядке:
SELECT uid, parent_uid, source_order, wbs, outline_level, is_summary, is_milestone,
       task_name, task_code, project_code, cbs_code, kfo_code,
       plan_start, plan_finish, actual_start, actual_finish,
       volume_plan, volume_fact, percent_complete
FROM tasks
ORDER BY source_order;

-- 2. Получить непосредственно дочерние строки выбранного UID (:parent_uid).
-- Связывание не зависит от названий или классификаторов.
SELECT uid, parent_uid, source_order, wbs, outline_level, task_name, task_code,
       is_summary, is_milestone, plan_start, plan_finish, actual_start, actual_finish,
       volume_plan, volume_fact, percent_complete
FROM tasks
WHERE parent_uid = :parent_uid
ORDER BY source_order;

-- 3. Полная ветвь выбранной работы (:root_uid).
WITH RECURSIVE subtree(uid) AS (
    SELECT uid FROM tasks WHERE uid = :root_uid
    UNION ALL
    SELECT child.uid FROM tasks AS child
    INNER JOIN subtree AS parent ON child.parent_uid = parent.uid
)
SELECT tasks.* FROM tasks JOIN subtree USING (uid)
ORDER BY source_order;

-- 4. Путь от текущей работы (:uid) вверх до корня (полезно для поиска).
WITH RECURSIVE ancestors(uid, parent_uid, source_order, level_from_target) AS (
  SELECT uid, parent_uid, source_order, 0 FROM tasks WHERE uid = :uid
  UNION ALL
  SELECT parent.uid, parent.parent_uid, parent.source_order, a.level_from_target + 1
  FROM tasks AS parent JOIN ancestors AS a ON a.parent_uid = parent.uid
)
SELECT t.uid, t.parent_uid, t.wbs, t.task_name, t.outline_level
FROM ancestors a JOIN tasks t ON a.uid = t.uid
ORDER BY a.level_from_target DESC;

-- 5. Контроли корректности структуры:
SELECT COUNT(*) AS all_tasks FROM tasks;
SELECT COUNT(*) AS roots FROM tasks WHERE parent_uid IS NULL;
SELECT COUNT(*) AS orphans FROM tasks t LEFT JOIN tasks p ON t.parent_uid = p.uid
WHERE t.parent_uid IS NOT NULL AND p.uid IS NULL;
SELECT COUNT(*) AS duplicate_task_codes FROM (
 SELECT task_code FROM tasks WHERE task_code IS NOT NULL GROUP BY task_code HAVING COUNT(*) > 1
);
