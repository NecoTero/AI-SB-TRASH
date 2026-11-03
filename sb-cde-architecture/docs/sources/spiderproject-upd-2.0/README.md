# SpiderProject → SB_CDE. Пакет UPD 2.0

## С чего начать

1. **`UPD_КОПИРОВАТЬ_В_ЗАДАЧУ.md`** — короткий готовый текст для передачи ИИ-агенту/разработчику.
2. **`UPD_2_0_SpiderProject_TreeGrid.md`** — полное техническое описание: модель данных, точные правила, UI, версии, тесты.
3. **`parse_msproject_xml.py`** — прежний скрипт, сохранён без изменений; создаёт `works.sqlite` из исходного XML.
4. **`spider_treegrid_adapter.py`** — новый скрипт, подготавливает JSON для Tree Grid из `works.sqlite`.
5. **`test_treegrid_contract.py`** — проверяет результат по оригинальным полям `works.sqlite`.
6. **`queries_for_treegrid_SQLite.sql`** — проверенные по структуре текущей SQLite-базы запросы.
7. **`example_result/`** — выполненная обработка демонстрационной версии с платформенным ID `DEMO-МАН16` **(не импортировать DEMO-ID в боевую БД)**.

## Быстрый запуск (Python 3.9+, без сторонних библиотек для JSON/SQLite)

```bash
python parse_msproject_xml.py down_PL_CON_13.xml --out parsed --no-xlsx
python spider_treegrid_adapter.py --db parsed/works.sqlite --platform-project-id <ACTUAL_PROJECT_ID> --out treegrid
python test_treegrid_contract.py --db parsed/works.sqlite --folder treegrid
```

При наличии **уже сформированной** `works.sqlite` первый шаг не нужен.

Новый скрипт выдаёт:
- `treegrid_rows.json` — список с `parent_row_id`, `source_order`, датами, объёмами, всеми исходными полями;
- `treegrid_tree.json` — вложенное представление **этих же** данных;
- `treegrid_manifest.json` — метаданные источника/версии;
- `treegrid_validation.json` — проверки связности.

TreeGrid на платформе должен получать **один** набор задач (желательно плоскую коллекцию и строить дерево по ссылкам), а не импортировать оба файла одновременно как отдельные сущности.

Физическую схему и интерфейс вашей платформы пакет **не меняет автоматически** — требуется адаптация текущего backend/frontend. Рабочая технология SB_CDE не задана, поэтому код интеграции намеренно не выдуман.
